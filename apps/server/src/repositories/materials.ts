import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  ExtractionStatus,
  MaterialDetail,
  MaterialKind,
  MaterialSummary,
} from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable, material } from "../db/schema.js";
import { ConflictError, isUniqueViolation } from "./conflict.js";

type MaterialRow = typeof material.$inferSelect;

export interface NewMaterial {
  kind: MaterialKind;
  originalName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  extractedText: string | null;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  pageCount: number | null;
}

function toMaterialSummary(row: MaterialRow): MaterialSummary {
  return {
    id: row.id,
    classId: row.classId,
    kind: row.kind,
    originalName: row.originalName,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    extractionStatus: row.extractionStatus,
    extractionError: row.extractionError,
    pageCount: row.pageCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Materials first, then notes ("material" sorts before "note"); each group by original name. */
export function listMaterials(db: Db, classId: number): MaterialSummary[] {
  return db
    .select()
    .from(material)
    .where(eq(material.classId, classId))
    .orderBy(asc(material.kind), asc(material.originalName), asc(material.id))
    .all()
    .map(toMaterialSummary);
}

/** The full row, including the storage path, for serving the file. */
export function getMaterialRow(db: Db, id: number): MaterialRow | undefined {
  return db.select().from(material).where(eq(material.id, id)).get();
}

export function getMaterial(db: Db, id: number): MaterialDetail | undefined {
  const row = getMaterialRow(db, id);
  return row && { ...toMaterialSummary(row), extractedText: row.extractedText };
}

/** Which of these hashes are already attached to the class. */
export function findExistingHashes(db: Db, classId: number, hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set();
  return new Set(
    db
      .select({ sha256: material.sha256 })
      .from(material)
      .where(and(eq(material.classId, classId), inArray(material.sha256, hashes)))
      .all()
      .map((row) => row.sha256),
  );
}

/** Inserts all rows or none. Throws `ConflictError` if a file is already in the class. */
export function insertMaterials(db: Db, classId: number, inputs: NewMaterial[]): MaterialSummary[] {
  try {
    return db.transaction((tx) =>
      inputs.map((input) =>
        toMaterialSummary(
          tx
            .insert(material)
            .values({ classId, ...input })
            .returning()
            .get(),
        ),
      ),
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("This file is already in the class");
    throw err;
  }
}

/** Returns the removed row's hash, or undefined if there was no such material. */
export function deleteMaterial(db: Db, id: number): string | undefined {
  return db.delete(material).where(eq(material.id, id)).returning({ sha256: material.sha256 }).get()
    ?.sha256;
}

/** Distinct hashes of a class's files; collect before deleting the class, which cascades. */
export function listClassHashes(db: Db, classId: number): string[] {
  return distinct(
    db
      .select({ sha256: material.sha256 })
      .from(material)
      .where(eq(material.classId, classId))
      .all(),
  );
}

/** Distinct hashes of all files in a course's classes; collect before deleting the course. */
export function listCourseHashes(db: Db, courseId: number): string[] {
  const classIds = db
    .select({ id: classTable.id })
    .from(classTable)
    .where(eq(classTable.courseId, courseId))
    .all()
    .map((row) => row.id);
  if (classIds.length === 0) return [];
  return distinct(
    db
      .select({ sha256: material.sha256 })
      .from(material)
      .where(inArray(material.classId, classIds))
      .all(),
  );
}

function distinct(rows: { sha256: string }[]): string[] {
  return [...new Set(rows.map((row) => row.sha256))];
}
