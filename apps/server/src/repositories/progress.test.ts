import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classTable, course, lesson, material } from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { getCourseProgress } from "./progress.js";

describe("getCourseProgress: classesWithoutLesson flag", () => {
  let t: TestApp;
  let courseId: number;
  let n = 0;

  const db = () => t.handle.db;
  const addClass = (status: "draft" | "generating" | "ready" | "failed") => {
    n += 1;
    return db()
      .insert(classTable)
      .values({ courseId, number: n, title: `Čas ${n}`, status })
      .returning()
      .get();
  };
  const addMaterial = (classId: number, overrides: Partial<typeof material.$inferInsert> = {}) => {
    n += 1;
    db()
      .insert(material)
      .values({
        classId,
        kind: "material",
        originalName: "slajdovi.pdf",
        mime: "application/pdf",
        sizeBytes: 1,
        sha256: String(n).padStart(64, "0"),
        storagePath: "files/aa/x.pdf",
        extractedText: "tekst",
        extractionStatus: "ok",
        ...overrides,
      })
      .run();
  };
  const flags = () => getCourseProgress(db(), courseId).flags.classesWithoutLesson;

  beforeEach(() => {
    t = createTestApp();
    courseId = db().insert(course).values({ name: "Kurs" }).returning().get().id;
    n = 0;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("flags a draft class with usable materials", () => {
    const cls = addClass("draft");
    addMaterial(cls.id);
    expect(flags()).toEqual([
      { classId: cls.id, number: cls.number, title: cls.title, status: "draft" },
    ]);
  });

  it("flags a failed class with usable materials and no lesson, with its status", () => {
    const cls = addClass("failed");
    addMaterial(cls.id);
    expect(flags()).toEqual([
      { classId: cls.id, number: cls.number, title: cls.title, status: "failed" },
    ]);
  });

  it("does not flag a ready class with a lesson", () => {
    const cls = addClass("ready");
    addMaterial(cls.id);
    db().insert(lesson).values({ classId: cls.id, bodyMd: "# Lekcija" }).run();
    expect(flags()).toEqual([]);
  });

  it("does not flag a failed class that already has a lesson", () => {
    const cls = addClass("failed");
    addMaterial(cls.id);
    db().insert(lesson).values({ classId: cls.id, bodyMd: "# Lekcija" }).run();
    expect(flags()).toEqual([]);
  });

  it("does not flag draft or failed classes without usable materials", () => {
    const empty = addClass("draft");
    const onlyNote = addClass("failed");
    addMaterial(onlyNote.id, { kind: "note" });
    const badExtraction = addClass("draft");
    addMaterial(badExtraction.id, { extractionStatus: "failed", extractedText: null });
    expect(empty.id).toBeGreaterThan(0);
    expect(flags()).toEqual([]);
  });
});
