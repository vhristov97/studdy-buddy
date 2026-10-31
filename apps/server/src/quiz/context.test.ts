import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";
import { classTable, course, lesson, topic, topicEvent } from "../db/schema.js";
import { loadQuizContext, notesMisconceptions } from "./context.js";

let dir: string;
let handle: DatabaseHandle;
let class1: number;
let class2: number;
let class3: number;

function addClass(courseId: number, number: number, withLesson: boolean): number {
  const { db } = handle;
  const cls = db
    .insert(classTable)
    .values({ courseId, number, title: `Predavanje ${number}`, status: "ready" })
    .returning()
    .get();
  if (withLesson)
    db.insert(lesson)
      .values({ classId: cls.id, bodyMd: `Lekcija ${number}` })
      .run();
  return cls.id;
}

function addTopic(
  courseId: number,
  classId: number,
  position: number,
  name: string,
  rating: "?" | "✗" | "~" | "✓",
  extra: { deferred?: boolean; deferredNote?: string } = {},
): number {
  return handle.db
    .insert(topic)
    .values({
      courseId,
      classId,
      position,
      name,
      rating,
      deferred: extra.deferred ?? false,
      deferredNote: extra.deferredNote ?? null,
    })
    .returning()
    .get().id;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-quizctx-test-"));
  handle = openDatabase(dir);
  migrate(handle.db);
  const { db } = handle;
  const c = db
    .insert(course)
    .values({ name: "Kurs", persona: "inženjer", assessmentFormat: "Usmeni ispit" })
    .returning()
    .get();
  class1 = addClass(c.id, 1, true);
  class2 = addClass(c.id, 2, true);
  class3 = addClass(c.id, 3, false);

  const weak = addTopic(c.id, class1, 0, "Slaba tema", "✗");
  addTopic(c.id, class1, 1, "Jaka tema", "✓");
  const partly = addTopic(c.id, class1, 2, "Delimična tema", "~");
  const notesOnly = addTopic(c.id, class1, 3, "Tema sa zabludom", "?");
  addTopic(c.id, class1, 4, "Neocenjena tema", "?");
  addTopic(c.id, class1, 5, "Odložena tema", "✗", { deferred: true, deferredNote: "Kasnije." });
  const fixed = addTopic(c.id, class1, 6, "Ispravljena tema", "✓");
  db.insert(topicEvent)
    .values([
      {
        topicId: weak,
        source: "quiz",
        ref: "P01",
        outcome: "wrong",
        misconceptionText: "Zabluda A",
      },
      { topicId: partly, source: "quiz", ref: "P01", outcome: "gap" },
      {
        topicId: notesOnly,
        source: "notes",
        outcome: "misconception",
        misconceptionText: "Zabluda iz beleški",
        correctionText: "Ispravno",
      },
      {
        topicId: fixed,
        source: "grading",
        ref: "P01",
        outcome: "wrong",
        misconceptionText: "Stara",
      },
    ])
    .run();

  const second = addTopic(c.id, class2, 0, "Druga tema", "?");
  addTopic(c.id, class2, 1, "Prva tema", "?", {
    deferred: true,
    deferredNote: "Na sledećem času.",
  });
  db.insert(topicEvent)
    .values({
      topicId: second,
      source: "notes",
      outcome: "misconception",
      misconceptionText: "Zabluda B",
      correctionText: "Ispravno B",
    })
    .run();
});

afterAll(() => {
  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadQuizContext", () => {
  it("loads the course, class, code, lesson and topics in lesson order", () => {
    const ctx = loadQuizContext(handle.db, class2);
    expect(ctx.course).toEqual({
      name: "Kurs",
      persona: "inženjer",
      assessmentFormat: "Usmeni ispit",
    });
    expect(ctx.class).toEqual({ id: class2, number: 2, title: "Predavanje 2" });
    expect(ctx.code).toBe("P02");
    expect(ctx.lessonMd).toBe("Lekcija 2");
    expect(ctx.topics.map((t) => t.name)).toEqual(["Druga tema", "Prva tema"]);
    expect(ctx.topics[1]).toMatchObject({ deferred: true, deferredNote: "Na sledećem času." });
    expect(ctx.topics[0]!.history).toEqual([
      {
        source: "notes",
        ref: null,
        outcome: "misconception",
        misconception: "Zabluda B",
        correction: "Ispravno B",
      },
    ]);
    expect(ctx.backlog).toEqual([]);
    expect(ctx.observations).toEqual([]);
  });

  it("lists only weak or misconception-bearing, non-deferred topics of earlier classes", () => {
    const ctx = loadQuizContext(handle.db, class2);
    expect(ctx.earlierTopics.map((t) => t.name)).toEqual([
      "Slaba tema",
      "Delimična tema",
      "Tema sa zabludom",
      "Ispravljena tema",
    ]);
    expect(ctx.earlierTopics.every((t) => t.classNumber === 1)).toBe(true);
    expect(ctx.earlierTopics[0]!.history[0]).toMatchObject({
      source: "quiz",
      ref: "P01",
      misconception: "Zabluda A",
    });
  });

  it("has no earlier topics for the first class", () => {
    expect(loadQuizContext(handle.db, class1).earlierTopics).toEqual([]);
  });

  it("throws for a missing class or a class without a lesson", () => {
    expect(() => loadQuizContext(handle.db, 9999)).toThrow(/does not exist/);
    expect(() => loadQuizContext(handle.db, class3)).toThrow(/no lesson/);
  });
});

describe("notesMisconceptions", () => {
  it("returns the notes misconceptions of this class's topics only", () => {
    expect(notesMisconceptions(loadQuizContext(handle.db, class2))).toEqual([
      { topic: "Druga tema", claim: "Zabluda B", correction: "Ispravno B" },
    ]);
  });
});
