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

/** sha256 hex digest of the content: the name a file is stored under. */
export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Hashes with an upload in flight: its file is saved but its row isn't inserted yet, so no
 * `material` row protects it. The server is a single process, so an in-memory count is enough.
 */
const reservedHashes = new Map<string, number>();

/**
 * Keeps `deleteFileIfUnreferenced` away from these hashes until the returned function is called
 * (calling it again is harmless). Reserve before `saveFile`, release once the rows are inserted
 * or the upload has failed and cleaned up.
 */
export function reserveHashes(hashes: Iterable<string>): () => void {
  const held = [...new Set(hashes)];
  for (const sha256 of held) reservedHashes.set(sha256, (reservedHashes.get(sha256) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const sha256 of held) {
      const count = (reservedHashes.get(sha256) ?? 0) - 1;
      if (count > 0) reservedHashes.set(sha256, count);
      else reservedHashes.delete(sha256);
    }
  };
}

/** Writes the buffer to `<dataDir>/files/<first 2 hex>/<sha256>.<ext>`; a no-op if it already exists. */
export function saveFile(dataDir: string, buffer: Buffer, ext: string): SavedFile {
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(cleanExt)) throw new Error(`Invalid file extension: ${ext}`);
  const sha256 = hashBuffer(buffer);
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
 * Removes the stored file(s) for a hash, but only when no `material` row references it anymore
 * and no upload has reserved it. Returns true if a file was removed.
 */
export function deleteFileIfUnreferenced(db: Db, dataDir: string, sha256: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`);
  const stillUsed = db
    .select({ id: material.id })
    .from(material)
    .where(eq(material.sha256, sha256))
    .limit(1)
    .get();
  if (stillUsed || reservedHashes.has(sha256)) return false;

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
