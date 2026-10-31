import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classTable, course, material } from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { deleteFileIfUnreferenced, reserveHashes, resolveStoredPath, saveFile } from "./store.js";

describe("file store", () => {
  let t: TestApp;

  beforeEach(() => {
    t = createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("saves content-addressed under files/<first 2 hex>/<sha256>.<ext>", () => {
    const buffer = Buffer.from("hello");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const saved = saveFile(t.dir, buffer, ".PDF");
    expect(saved).toEqual({ sha256, storagePath: `files/${sha256.slice(0, 2)}/${sha256}.pdf` });
    expect(fs.readFileSync(path.join(t.dir, saved.storagePath))).toEqual(buffer);
    expect(fs.readdirSync(path.dirname(path.join(t.dir, saved.storagePath)))).toHaveLength(1);
  });

  it("is a no-op when the file already exists", () => {
    const first = saveFile(t.dir, Buffer.from("same"), "md");
    const target = path.join(t.dir, first.storagePath);
    const mtime = fs.statSync(target).mtimeMs;
    expect(saveFile(t.dir, Buffer.from("same"), "md")).toEqual(first);
    expect(fs.statSync(target).mtimeMs).toBe(mtime);
  });

  it("rejects odd extensions", () => {
    expect(() => saveFile(t.dir, Buffer.from("x"), "../evil")).toThrow(/extension/);
  });

  it("refuses paths that escape the files directory", () => {
    expect(resolveStoredPath(t.dir, "files/ab/x.pdf")).toBe(path.join(t.dir, "files/ab/x.pdf"));
    for (const bad of ["../app.sqlite", "files/../app.sqlite", "/etc/passwd", "files", "files/"]) {
      expect(() => resolveStoredPath(t.dir, bad)).toThrow(/outside the file store/);
    }
  });

  it("deletes a file only when no material references the hash", () => {
    const { db } = t.handle;
    const saved = saveFile(t.dir, Buffer.from("shared"), "md");
    const courseRow = db.insert(course).values({ name: "C" }).returning().get();
    const classRow = db
      .insert(classTable)
      .values({ courseId: courseRow.id, number: 1, title: "T" })
      .returning()
      .get();
    db.insert(material)
      .values({
        classId: classRow.id,
        kind: "note",
        originalName: "a.md",
        mime: "text/markdown",
        sizeBytes: 6,
        sha256: saved.sha256,
        storagePath: saved.storagePath,
        extractionStatus: "ok",
      })
      .run();

    const target = path.join(t.dir, saved.storagePath);
    expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);

    db.delete(material).run();
    expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(false);
  });

  describe("reservations", () => {
    it("keeps an unreferenced file while its hash is reserved, and removes it after the release", () => {
      const { db } = t.handle;
      const saved = saveFile(t.dir, Buffer.from("in flight"), "md");
      const target = path.join(t.dir, saved.storagePath);

      const release = reserveHashes([saved.sha256]);
      expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(false);
      expect(fs.existsSync(target)).toBe(true);

      release();
      expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    });

    it("counts overlapping reservations and ignores a repeated release", () => {
      const { db } = t.handle;
      const saved = saveFile(t.dir, Buffer.from("two uploads"), "md");
      const first = reserveHashes([saved.sha256, saved.sha256]);
      const second = reserveHashes([saved.sha256]);

      first();
      first();
      expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(false);

      second();
      expect(deleteFileIfUnreferenced(db, t.dir, saved.sha256)).toBe(true);
    });
  });

  it("rejects a malformed hash", () => {
    expect(() => deleteFileIfUnreferenced(t.handle.db, t.dir, "../../etc")).toThrow(/sha256/);
  });
});
