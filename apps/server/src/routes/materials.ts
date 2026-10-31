import fs from "node:fs";
import path from "node:path";
import fastifyMultipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  ACCEPTED_FILE_TYPES,
  MAX_MATERIAL_SIZE_BYTES,
  type MaterialKind,
  type MaterialSummary,
} from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable } from "../db/schema.js";
import { extractText } from "../extraction/index.js";
import { deleteUnreferencedFiles, resolveStoredPath, saveFile } from "../files/store.js";
import {
  deleteMaterial,
  findExistingHashes,
  getMaterial,
  getMaterialRow,
  insertMaterials,
  listMaterials,
  type NewMaterial,
} from "../repositories/materials.js";
import { ApiError, notFound, parseId } from "./errors.js";

export interface MaterialRouteOptions {
  db: Db;
  dataDir: string;
}

interface ClassParams {
  classId: string;
}

interface MaterialParams {
  materialId: string;
}

const LOCKED_MESSAGE = "Class materials can't be changed after generation";
/** An uploaded page must never run scripts in the app's origin, even when opened directly. */
const HTML_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const MAX_EXTRACTION_ERROR_LENGTH = 500;
const MAX_NAME_LENGTH = 255;
const MAX_FILES_PER_UPLOAD = 20;

interface UploadedFile {
  originalName: string;
  ext: string;
  mime: string;
  kind: MaterialKind;
  buffer: Buffer;
}

/** Throws unless the class exists and still accepts changes. */
function requireDraftClass(db: Db, classId: number): void {
  const row = db
    .select({ status: classTable.status })
    .from(classTable)
    .where(eq(classTable.id, classId))
    .get();
  if (!row) throw notFound("Class");
  if (row.status !== "draft") throw new ApiError(409, "conflict", LOCKED_MESSAGE);
}

function cleanFileName(raw: string): string {
  const name = path
    .basename(raw.replace(/\\/g, "/"))
    .replace(/\p{Cc}/gu, "")
    .trim();
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

/** Decides the type from the extension and checks that the content matches it. */
function validateUpload(rawName: string, buffer: Buffer): UploadedFile {
  const originalName = cleanFileName(rawName);
  const ext = path.extname(originalName).toLowerCase();
  const type = ACCEPTED_FILE_TYPES[ext];
  if (!type) {
    throw new ApiError(
      415,
      "validation",
      `Unsupported file type: ${originalName || "(no name)"}. Use ${Object.keys(ACCEPTED_FILE_TYPES).join(", ")}`,
    );
  }
  if (buffer.length === 0) {
    throw new ApiError(400, "validation", `${originalName} is empty`);
  }
  if (type.mime === "application/pdf") {
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new ApiError(400, "validation", `${originalName} is not a valid PDF file`);
    }
  } else {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ApiError(400, "validation", `${originalName} is not valid UTF-8 text`);
    }
  }
  return { originalName, ext, mime: type.mime, kind: type.kind, buffer };
}

export const materialRoutes: FastifyPluginAsync<MaterialRouteOptions> = async (
  app,
  { db, dataDir },
) => {
  // Registered here, not on the root app, so its request hooks only run for these routes.
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_MATERIAL_SIZE_BYTES, files: MAX_FILES_PER_UPLOAD },
  });

  app.post<{ Params: ClassParams }>("/api/classes/:classId/materials", async (request, reply) => {
    const classId = parseId("classId", request.params.classId);
    requireDraftClass(db, classId);
    if (!request.isMultipart()) {
      throw new ApiError(400, "validation", "Expected a multipart/form-data upload");
    }

    const uploads: UploadedFile[] = [];
    for await (const part of request.parts()) {
      if (part.type !== "file") continue;
      if (part.fieldname !== "files") {
        throw new ApiError(400, "validation", `Unexpected file field "${part.fieldname}"`);
      }
      const buffer = await part.toBuffer();
      uploads.push(validateUpload(part.filename, buffer));
    }
    if (uploads.length === 0) {
      throw new ApiError(400, "validation", 'No files were uploaded (use the "files" field)');
    }

    const saved = uploads.map((upload) => ({
      upload,
      ...saveFile(dataDir, upload.buffer, upload.ext),
    }));
    const hashes = saved.map((file) => file.sha256);
    try {
      const duplicates = findExistingHashes(db, classId, hashes);
      const seen = new Set<string>();
      for (const file of saved) {
        if (duplicates.has(file.sha256) || seen.has(file.sha256)) {
          throw new ApiError(
            409,
            "conflict",
            `${file.upload.originalName} is already in this class`,
          );
        }
        seen.add(file.sha256);
      }

      const rows: NewMaterial[] = [];
      for (const { upload, sha256, storagePath } of saved) {
        const base = {
          kind: upload.kind,
          originalName: upload.originalName,
          mime: upload.mime,
          sizeBytes: upload.buffer.length,
          sha256,
          storagePath,
        };
        try {
          const { text, pageCount } = await extractText(upload.kind, upload.mime, upload.buffer);
          rows.push({
            ...base,
            extractedText: text,
            extractionStatus: "ok",
            extractionError: null,
            pageCount,
          });
        } catch (err) {
          request.log.warn({ err, file: upload.originalName }, "text extraction failed");
          const message = err instanceof Error ? err.message : String(err);
          rows.push({
            ...base,
            extractedText: null,
            extractionStatus: "failed",
            extractionError: message.slice(0, MAX_EXTRACTION_ERROR_LENGTH),
            pageCount: null,
          });
        }
      }

      // The class may have been generated while extraction ran.
      requireDraftClass(db, classId);
      const created: MaterialSummary[] = insertMaterials(db, classId, rows);
      return reply.code(201).send(created);
    } catch (err) {
      // Don't leave files behind that no row references.
      deleteUnreferencedFiles(db, dataDir, hashes, (cleanupErr) =>
        request.log.warn({ err: cleanupErr }, "could not remove an unreferenced file"),
      );
      throw err;
    }
  });

  app.get<{ Params: ClassParams }>("/api/classes/:classId/materials", async (request) => {
    const classId = parseId("classId", request.params.classId);
    const exists = db
      .select({ id: classTable.id })
      .from(classTable)
      .where(eq(classTable.id, classId))
      .get();
    if (!exists) throw notFound("Class");
    return listMaterials(db, classId);
  });

  app.get<{ Params: MaterialParams }>("/api/materials/:materialId", async (request) => {
    const found = getMaterial(db, parseId("materialId", request.params.materialId));
    if (!found) throw notFound("Material");
    return found;
  });

  app.get<{ Params: MaterialParams }>("/api/materials/:materialId/file", async (request, reply) => {
    const row = getMaterialRow(db, parseId("materialId", request.params.materialId));
    if (!row) throw notFound("Material");
    const filePath = resolveStoredPath(dataDir, row.storagePath);
    if (!fs.existsSync(filePath)) throw notFound("Stored file");

    reply
      .header(
        "Content-Type",
        row.mime.startsWith("text/") ? `${row.mime}; charset=utf-8` : row.mime,
      )
      .header("Content-Disposition", `inline; filename*=UTF-8''${encodeRfc5987(row.originalName)}`)
      .header("X-Content-Type-Options", "nosniff");
    if (row.mime === "text/html") reply.header("Content-Security-Policy", HTML_CSP);
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete<{ Params: MaterialParams }>("/api/materials/:materialId", async (request, reply) => {
    const id = parseId("materialId", request.params.materialId);
    const row = getMaterialRow(db, id);
    if (!row) throw notFound("Material");
    requireDraftClass(db, row.classId);
    deleteMaterial(db, id);
    deleteUnreferencedFiles(db, dataDir, [row.sha256], (err) =>
      request.log.warn({ err }, "could not remove an unreferenced file"),
    );
    return reply.code(204).send();
  });
};

/** encodeURIComponent plus the characters RFC 5987 does not allow in an ext-value. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
