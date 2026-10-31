import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classTable,
  course,
  lesson,
  material,
  visualization,
  vizSuggestion,
} from "../db/schema.js";
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

describe("getCourseProgress: visualizations", () => {
  let t: TestApp;
  let courseId: number;

  const db = () => t.handle.db;

  beforeEach(() => {
    t = createTestApp();
    courseId = db().insert(course).values({ name: "Kurs" }).returning().get().id;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("lists the course's visualizations newest first with concept and misconception", () => {
    const cls = db()
      .insert(classTable)
      .values({ courseId, number: 2, title: "Kafka", status: "ready" })
      .returning()
      .get();
    const other = db().insert(course).values({ name: "Drugi" }).returning().get();
    const otherCls = db()
      .insert(classTable)
      .values({ courseId: other.id, number: 1, title: "Tuđe", status: "ready" })
      .returning()
      .get();
    const suggestion = db()
      .insert(vizSuggestion)
      .values({
        classId: cls.id,
        concept: "Replikacija",
        section: "",
        misconception: "Isto što i particionisanje",
        summary: "s",
        controlsJson: [],
        scenariosJson: [],
        origin: "agent",
      })
      .returning()
      .get();
    const add = (classId: number, slug: string, suggestionId: number | null) =>
      db()
        .insert(visualization)
        .values({ classId, suggestionId, slug, title: `Viz ${slug}`, html: "<p></p>" })
        .returning()
        .get();
    const first = add(cls.id, "a", suggestion.id);
    const second = add(cls.id, "b", null);
    add(otherCls.id, "c", null);

    expect(getCourseProgress(db(), courseId).visualizations).toEqual([
      {
        id: second.id,
        title: "Viz b",
        classNumber: 2,
        className: "Kafka",
        concept: null,
        misconception: null,
        createdAt: second.createdAt.toISOString(),
      },
      {
        id: first.id,
        title: "Viz a",
        classNumber: 2,
        className: "Kafka",
        concept: "Replikacija",
        misconception: "Isto što i particionisanje",
        createdAt: first.createdAt.toISOString(),
      },
    ]);
  });

  it("keeps null concept and misconception when the suggestion was deleted", () => {
    const cls = db()
      .insert(classTable)
      .values({ courseId, number: 1, title: "Uvod", status: "ready" })
      .returning()
      .get();
    const suggestion = db()
      .insert(vizSuggestion)
      .values({
        classId: cls.id,
        concept: "C",
        section: "",
        misconception: "M",
        summary: "s",
        controlsJson: [],
        scenariosJson: [],
        origin: "user",
      })
      .returning()
      .get();
    db()
      .insert(visualization)
      .values({ classId: cls.id, suggestionId: suggestion.id, slug: "x", title: "X", html: "" })
      .run();
    db().delete(vizSuggestion).where(eq(vizSuggestion.id, suggestion.id)).run();
    const [entry] = getCourseProgress(db(), courseId).visualizations;
    expect(entry).toMatchObject({ title: "X", concept: null, misconception: null });
  });
});
