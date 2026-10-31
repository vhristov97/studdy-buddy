import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { material } from "../db/schema.js";

const FILES_DIR = "files";

export interface SavedFile {
  sha256: string;
  /** Relative to the data dir, always with forward slashes, e.g. `files/ab/<sha256>.pdf`. */
  storagePath: string;
}

/** Writes the buffer to `<dataDir>/files/<first 2 hex>/<sha256>.<ext>`; a no-op if it already exists. */
export function saveFile(dataDir: string, buffer: Buffer, ext: string): SavedFile {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(cleanExt)) throw new Error(`Invalid file extension: ${ext}`);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const storagePath = `${FILES_DIR}/${sha256.slice(0, 2)}/${sha256}.${cleanExt}`;
  const target = resolveStoredPath(dataDir, storagePath);
  if (fs.existsSync(target)) return { sha256, storagePath };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return { sha256, storagePath };
}

/** Absolute path of a stored file; throws if `storagePath` escapes `<dataDir>/files`. */
export function resolveStoredPath(dataDir: string, storagePath: string): string {
  const root = path.resolve(dataDir, FILES_DIR);
  const resolved = path.resolve(dataDir, storagePath);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to access a path outside the file store: ${storagePath}`);
  }
  return resolved;
}

/**
 * Removes the stored file(s) for a hash, but only when no `material` row references it anymore.
 * Returns true if a file was removed.
 */
export function deleteFileIfUnreferenced(db: Db, dataDir: string, sha256: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
  const stillUsed = db
    .select({ id: material.id })
    .from(material)
    .where(eq(material.sha256, sha256))
    .limit(1)
    .get();
  if (stillUsed) return false;

  const probe = resolveStoredPath(dataDir, `${FILES_DIR}/${sha256.slice(0, 2)}/${sha256}.x`);
  const folder = path.dirname(probe);
  let removed = false;
  let entries: string[];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return false;
  }
  for (const entry of entries) {
    // Matches `<sha256>.<ext>` exactly; leaves temp files of concurrent writes alone.
    if (entry.startsWith(`${sha256}.`) && !entry.endsWith(".tmp")) {
      fs.rmSync(path.join(folder, entry), { force: true });
      removed = true;
    }
  }
  return removed;
}

/** Best-effort cleanup after rows were deleted: a failure is reported to `onError`, never thrown. */
export function deleteUnreferencedFiles(
  db: Db,
  dataDir: string,
  hashes: Iterable<string>,
  onError?: (err: unknown) => void,
): void {
  for (const sha256 of hashes) {
    try {
      deleteFileIfUnreferenced(db, dataDir, sha256);
    } catch (err) {
      onError?.(err);
    }
  }
}
