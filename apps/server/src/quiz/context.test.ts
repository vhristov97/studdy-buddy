import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ctxFixture, planFixture } from "../agents/testing/quiz-fixtures.js";
import { quizPlanSchema } from "../agents/quiz-planner.js";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";
import {
  backlogItem,
  classTable,
  course,
  learnerObservation,
  lesson,
  topic,
  topicEvent,
} from "../db/schema.js";
import { loadQuizContext, notesMisconceptions } from "./context.js";

let dir: string;
let handle: DatabaseHandle;
let class1: number;
let class2: number;
let class3: number;
let limitClass: number;
let backlogClass3: number;
let backlogClass5: number;
let deferredBacklogClass: number;

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

  // A second course: five earlier classes where #1-#4 have weak topics and #5 has none.
  const c2 = db.insert(course).values({ name: "Kurs 2" }).returning().get();
  for (let n = 1; n <= 5; n++) {
    const id = addClass(c2.id, n, true);
    addTopic(c2.id, id, 0, `Tema ${n}`, n <= 4 ? "✗" : "✓");
  }
  limitClass = addClass(c2.id, 6, true);

  // Backlog courses: class 1 has an untested topic without history that sits on the backlog.
  const withBacklog = (name: string, weakClasses: number[], targetNumber: number): number => {
    const bc = db.insert(course).values({ name }).returning().get();
    const first = addClass(bc.id, 1, true);
    const leftOut = addTopic(bc.id, first, 0, "Neocenjena tema", "?");
    db.insert(backlogItem)
      .values({ courseId: bc.id, topicId: leftOut, dueQuiz: "K1", reason: "left_out" })
      .run();
    for (let n = 2; n < targetNumber; n++) {
      const id = addClass(bc.id, n, true);
      if (weakClasses.includes(n)) addTopic(bc.id, id, 0, `Slaba ${n}`, "✗");
    }
    return addClass(bc.id, targetNumber, true);
  };
  backlogClass3 = withBacklog("Kurs 3", [], 3);
  backlogClass5 = withBacklog("Kurs 4", [2, 3, 4], 5);

  // A deferred topic that grading backlogged (left_out) is not a repeat candidate.
  const dc = db.insert(course).values({ name: "Kurs 5" }).returning().get();
  const dFirst = addClass(dc.id, 1, true);
  const dTopic = addTopic(dc.id, dFirst, 0, "Odložena u backlogu", "?", {
    deferred: true,
    deferredNote: "Na sledećem času.",
  });
  db.insert(backlogItem)
    .values({ courseId: dc.id, topicId: dTopic, dueQuiz: "K1", reason: "left_out" })
    .run();
  deferredBacklogClass = addClass(dc.id, 2, true);
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
  });

  it("loads the unresolved backlog of the course and the observations", () => {
    const { db } = handle;
    const c = db.select().from(course).where(eq(course.name, "Kurs")).get()!;
    const slaba = db.select().from(topic).where(eq(topic.name, "Slaba tema")).get()!;
    const druga = db.select().from(topic).where(eq(topic.name, "Druga tema")).get()!;
    db.insert(backlogItem)
      .values([
        { courseId: c.id, topicId: slaba.id, dueQuiz: "K1", reason: "weak" },
        { courseId: c.id, topicId: druga.id, dueQuiz: "K2", reason: "gap" },
        {
          courseId: c.id,
          topicId: druga.id,
          dueQuiz: "K1",
          reason: "left_out",
          resolvedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ])
      .run();
    db.insert(learnerObservation)
      .values([{ text: "Prva" }, { text: "Druga" }])
      .run();
    const ctx = loadQuizContext(db, class2);
    expect(ctx.backlog).toEqual([
      { topic: "Slaba tema", classNumber: 1, dueQuiz: "K1", reason: "weak", deferred: false },
      { topic: "Druga tema", classNumber: 2, dueQuiz: "K2", reason: "gap", deferred: false },
    ]);
    expect(ctx.observations).toEqual(["Prva", "Druga"]);
    db.delete(backlogItem).where(eq(backlogItem.courseId, c.id)).run();
    db.delete(learnerObservation).run();
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

  it("has no earlier topics or lessons for the first class", () => {
    const ctx = loadQuizContext(handle.db, class1);
    expect(ctx.earlierTopics).toEqual([]);
    expect(ctx.earlierLessons).toEqual([]);
  });

  it("provides the lessons of the earlier classes that have repeat candidates", () => {
    expect(loadQuizContext(handle.db, class2).earlierLessons).toEqual([
      { classNumber: 1, title: "Predavanje 1", lessonMd: "Lekcija 1" },
    ]);
  });

  it("limits earlier lessons to the 3 most recent classes with candidates and drops older topics", () => {
    const ctx = loadQuizContext(handle.db, limitClass);
    expect(ctx.earlierLessons.map((l) => l.classNumber)).toEqual([2, 3, 4]);
    expect(ctx.earlierTopics.map((t) => [t.classNumber, t.name])).toEqual([
      [2, "Tema 2"],
      [3, "Tema 3"],
      [4, "Tema 4"],
    ]);
  });

  it("offers an unresolved backlog topic from an earlier class as a repeat candidate, weak or not", () => {
    const ctx = loadQuizContext(handle.db, backlogClass3);
    expect(ctx.earlierTopics).toEqual([
      {
        classNumber: 1,
        name: "Neocenjena tema",
        rating: "?",
        deferred: false,
        deferredNote: null,
        history: [],
      },
    ]);
    expect(ctx.earlierLessons).toEqual([
      { classNumber: 1, title: "Predavanje 1", lessonMd: "Lekcija 1" },
    ]);
    // A plan repeating it with classNumber 1 validates against the planner's schema.
    const plannerCtx = ctxFixture({ earlierTopics: ctx.earlierTopics });
    const plan = planFixture();
    plan.questions[5]!.topic = "Neocenjena tema";
    plan.questions[5]!.classNumber = 1;
    const result = quizPlanSchema(plannerCtx).safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("never offers a deferred backlog topic as a repeat candidate and pulls no lesson for it", () => {
    const ctx = loadQuizContext(handle.db, deferredBacklogClass);
    expect(ctx.earlierTopics).toEqual([]);
    expect(ctx.earlierLessons).toEqual([]);
    // It stays on the backlog list, marked deferred.
    expect(ctx.backlog).toEqual([
      expect.objectContaining({ topic: "Odložena u backlogu", classNumber: 1, deferred: true }),
    ]);
    // A plan repeating it is rejected, with the reason.
    const plan = planFixture();
    plan.questions[5]!.topic = "Odložena u backlogu";
    plan.questions[5]!.classNumber = 1;
    const result = quizPlanSchema(ctxFixture({ ...ctx, topics: ctxFixture().topics })).safeParse(
      plan,
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join("\n")).toContain(
      "deferred backlog item",
    );
  });

  it("keeps backlog classes when trimming to the lesson limit; weak classes fill the rest", () => {
    const ctx = loadQuizContext(handle.db, backlogClass5);
    expect(ctx.earlierLessons.map((l) => l.classNumber)).toEqual([1, 3, 4]);
    expect(ctx.earlierTopics.map((t) => [t.classNumber, t.name])).toEqual([
      [1, "Neocenjena tema"],
      [3, "Slaba 3"],
      [4, "Slaba 4"],
    ]);
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
