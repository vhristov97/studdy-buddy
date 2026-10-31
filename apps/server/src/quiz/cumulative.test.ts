import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";
import {
  backlogItem,
  classTable,
  course,
  generationJob,
  lesson,
  quiz,
  submission,
  topic,
  topicEvent,
} from "../db/schema.js";
import { ConflictError } from "../repositories/conflict.js";
import { loadCumulativeContext } from "./context.js";
import {
  cumulativeSchedule,
  cumulativeStatus,
  nextFreeCumulativeCode,
  parseCumulativeCode,
  resolveCumulativeTarget,
} from "./cumulative.js";

let dir: string;
let handle: DatabaseHandle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-cumulative-test-"));
  handle = openDatabase(dir);
  migrate(handle.db);
});
afterEach(() => {
  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const db = () => handle.db;

function addCourse(cadence: number | null): number {
  return db()
    .insert(course)
    .values({ name: "Kurs", persona: "inženjer", reviewCadence: cadence })
    .returning({ id: course.id })
    .get().id;
}

function addClass(
  courseId: number,
  number: number,
  opts: { status?: "ready" | "draft" | "generating"; lesson?: string | null } = {},
): number {
  const id = db()
    .insert(classTable)
    .values({ courseId, number, title: `Predavanje ${number}`, status: opts.status ?? "ready" })
    .returning({ id: classTable.id })
    .get().id;
  const body = opts.lesson === undefined ? `# Lekcija ${number}\n\nTekst ${number}.` : opts.lesson;
  if (body !== null) db().insert(lesson).values({ classId: id, bodyMd: body }).run();
  return id;
}

function addTopic(
  courseId: number,
  classId: number,
  position: number,
  name: string,
  rating: "?" | "✗" | "~" | "✓" = "?",
  deferred = false,
): number {
  return db()
    .insert(topic)
    .values({ courseId, classId, position, name, rating, deferred })
    .returning({ id: topic.id })
    .get().id;
}

function addK(courseId: number, code: string, jobClassId: number | null): number {
  const jobId =
    jobClassId === null
      ? null
      : db()
          .insert(generationJob)
          .values({
            classId: jobClassId,
            kind: "quiz",
            stage: "quiz-reviewer",
            status: "succeeded",
            attempt: 1,
            quizCode: code,
          })
          .returning({ id: generationJob.id })
          .get().id;
  return db()
    .insert(quiz)
    .values({
      courseId,
      classId: null,
      code,
      title: "K",
      subtitle: "K",
      chipsJson: [],
      questionsJson: [],
      jobId,
    })
    .returning({ id: quiz.id })
    .get().id;
}

describe("parseCumulativeCode", () => {
  it("accepts K<n> with n >= 1 only", () => {
    expect(parseCumulativeCode("K1")).toBe(1);
    expect(parseCumulativeCode("K12")).toBe(12);
    for (const bad of ["K0", "K", "P01", "k1", "K1R", "K-1"]) {
      expect(parseCumulativeCode(bad)).toBeNull();
    }
  });
});

describe("cumulativeStatus", () => {
  it("makes K<n> due once n * cadence classes are ready (cadence 2, classes 1..5)", () => {
    const courseId = addCourse(2);
    const due = (): unknown => cumulativeStatus(db(), courseId).due;
    expect(due()).toBeNull();
    const ids: number[] = [];
    const expected = [
      null,
      { code: "K1", coversThrough: 2, classNumbers: [1, 2] },
      { code: "K1", coversThrough: 2, classNumbers: [1, 2] },
      { code: "K1", coversThrough: 2, classNumbers: [1, 2] },
      { code: "K1", coversThrough: 2, classNumbers: [1, 2] },
    ];
    for (let n = 1; n <= 5; n++) {
      ids.push(addClass(courseId, n));
      expect(due()).toEqual(expected[n - 1]);
      expect(cumulativeStatus(db(), courseId)).toMatchObject({ cadence: 2, readyClassCount: n });
    }
  });

  it("offers the next review once the earlier one exists (K1 exists)", () => {
    const courseId = addCourse(2);
    const ids = [1, 2, 3, 4, 5].map((n) => addClass(courseId, n));
    const k1 = addK(courseId, "K1", ids[1]!);
    const status = cumulativeStatus(db(), courseId);
    expect(status.existing).toEqual([{ code: "K1", quizId: k1, coversThrough: 2 }]);
    expect(status.due).toEqual({ code: "K2", coversThrough: 4, classNumbers: [1, 2, 3, 4] });
  });

  it("offers nothing while K<n+1> needs more classes", () => {
    const courseId = addCourse(2);
    const ids = [1, 2, 3].map((n) => addClass(courseId, n));
    addK(courseId, "K1", ids[1]!);
    expect(cumulativeStatus(db(), courseId).due).toBeNull();
  });

  it("uses the smallest unused code even when only a later review exists", () => {
    const courseId = addCourse(2);
    const ids = [1, 2, 3, 4, 5, 6].map((n) => addClass(courseId, n));
    addK(courseId, "K2", ids[3]!);
    // K2 covers through class 4, so classes 5 and 6 are uncovered; the free code is K1.
    expect(cumulativeStatus(db(), courseId).due).toEqual({
      code: "K1",
      coversThrough: 6,
      classNumbers: [1, 2, 3, 4, 5, 6],
    });
  });

  it("is coverage-based: an early manual K1 does not stand in for the scheduled one", () => {
    const courseId = addCourse(4);
    const ids = [1, 2].map((n) => addClass(courseId, n));
    // Requested by hand after class 2, well before the cadence of 4.
    addK(courseId, "K1", ids[1]!);
    const due = (): unknown => cumulativeStatus(db(), courseId).due;
    expect(due()).toBeNull();
    ids.push(addClass(courseId, 3), addClass(courseId, 4), addClass(courseId, 5));
    // Classes 3..5 are only 3 uncovered classes: not yet.
    expect(due()).toBeNull();
    ids.push(addClass(courseId, 6));
    // Four uncovered classes (3..6): K2 is due and covers 1..6.
    expect(due()).toEqual({ code: "K2", coversThrough: 6, classNumbers: [1, 2, 3, 4, 5, 6] });
  });

  it("covers one cadence step past the last review; the rest follows as the next review", () => {
    const courseId = addCourse(2);
    const ids = [1, 2, 3, 4, 5].map((n) => addClass(courseId, n));
    addK(courseId, "K1", ids[0]!);
    // Uncovered: 2..5 (4 classes): one step of 2, through class 3.
    expect(cumulativeStatus(db(), courseId).due).toEqual({
      code: "K2",
      coversThrough: 3,
      classNumbers: [1, 2, 3],
    });
  });

  it("never has a due review without a cadence, but still lists existing ones", () => {
    const courseId = addCourse(null);
    const ids = [1, 2, 3].map((n) => addClass(courseId, n));
    expect(cumulativeStatus(db(), courseId)).toEqual({
      cadence: null,
      readyClassCount: 3,
      due: null,
      existing: [],
    });
    addK(courseId, "K1", ids[2]!);
    expect(cumulativeStatus(db(), courseId).existing).toEqual([
      expect.objectContaining({ code: "K1", coversThrough: 3 }),
    ]);
  });

  it("counts only classes with a ready lesson and uses class numbers, not positions", () => {
    const courseId = addCourse(2);
    addClass(courseId, 1);
    addClass(courseId, 2, { status: "generating", lesson: null });
    addClass(courseId, 3, { status: "draft", lesson: null });
    expect(cumulativeStatus(db(), courseId)).toMatchObject({ readyClassCount: 1, due: null });
    addClass(courseId, 5);
    expect(cumulativeStatus(db(), courseId).due).toEqual({
      code: "K1",
      coversThrough: 5,
      classNumbers: [1, 5],
    });
  });

  it("falls back to the highest ready class when the review has no job", () => {
    const courseId = addCourse(null);
    addClass(courseId, 1);
    addClass(courseId, 2);
    addK(courseId, "K1", null);
    expect(cumulativeStatus(db(), courseId).existing[0]!.coversThrough).toBe(2);
  });
});

describe("resolveCumulativeTarget", () => {
  it("uses the due review, covering exactly its classes", () => {
    const courseId = addCourse(2);
    const ids = [1, 2, 3].map((n) => addClass(courseId, n));
    expect(resolveCumulativeTarget(db(), courseId)).toEqual({
      code: "K1",
      throughClass: { id: ids[1], number: 2, title: "Predavanje 2" },
      due: true,
    });
  });

  it("creates the next free review over all ready classes when none is due or there is no cadence", () => {
    const courseId = addCourse(null);
    const ids = [1, 2, 3].map((n) => addClass(courseId, n));
    expect(resolveCumulativeTarget(db(), courseId)).toMatchObject({
      code: "K1",
      throughClass: { id: ids[2] },
      due: false,
    });
    addK(courseId, "K1", ids[2]!);
    expect(resolveCumulativeTarget(db(), courseId).code).toBe("K2");
  });

  it("uses the next free code covering everything for a manual request before the cadence", () => {
    const courseId = addCourse(4);
    const ids = [1, 2].map((n) => addClass(courseId, n));
    expect(resolveCumulativeTarget(db(), courseId)).toMatchObject({
      code: "K1",
      throughClass: { id: ids[1] },
      due: false,
    });
  });

  it("accepts an explicit non-due code and rejects existing codes and empty courses", () => {
    const courseId = addCourse(4);
    const ids = [1, 2].map((n) => addClass(courseId, n));
    expect(resolveCumulativeTarget(db(), courseId, "K3")).toMatchObject({
      code: "K3",
      throughClass: { id: ids[1] },
      due: false,
    });
    addK(courseId, "K3", ids[1]!);
    expect(() => resolveCumulativeTarget(db(), courseId, "K3")).toThrow(ConflictError);
    expect(() => resolveCumulativeTarget(db(), addCourse(2))).toThrow(ConflictError);
  });
});

describe("nextFreeCumulativeCode", () => {
  it("follows every existing review, or the one after a given review, never an existing code", () => {
    const courseId = addCourse(null);
    const ids = [1, 2].map((n) => addClass(courseId, n));
    expect(nextFreeCumulativeCode(db(), courseId)).toBe("K1");
    addK(courseId, "K1", ids[1]!);
    expect(nextFreeCumulativeCode(db(), courseId)).toBe("K2");
    addK(courseId, "K3", ids[1]!);
    expect(nextFreeCumulativeCode(db(), courseId)).toBe("K4");
    expect(nextFreeCumulativeCode(db(), courseId, { after: 1 })).toBe("K2");
    expect(nextFreeCumulativeCode(db(), courseId, { after: 2 })).toBe("K4");
    expect(nextFreeCumulativeCode(db(), courseId, { atLeast: 6 })).toBe("K6");
  });
});

describe("cumulativeSchedule: grading status", () => {
  function addSubmission(quizId: number): number {
    return db()
      .insert(submission)
      .values({
        quizId,
        answersJson: {},
        autoScore: 0,
        autoMax: 0,
        dontKnowJson: [],
        resultsJson: [],
        openPending: 1,
      })
      .returning({ id: submission.id })
      .get().id;
  }
  function addGradingJob(classId: number, submissionId: number, status: "running" | "failed") {
    db()
      .insert(generationJob)
      .values({
        classId,
        kind: "grading",
        stage: "grader",
        status,
        attempt: 1,
        submissionId,
        error: status === "failed" ? "API" : null,
      })
      .run();
  }
  const entry = (courseId: number) => cumulativeSchedule(db(), courseId)[0]!;

  it("is submitted while grading runs or has not started, grading_failed once the latest job failed", () => {
    const courseId = addCourse(null);
    const classId = addClass(courseId, 1);
    const k1 = addK(courseId, "K1", classId);
    expect(entry(courseId)).toMatchObject({ status: "available", submissionId: null });

    const sub = addSubmission(k1);
    expect(entry(courseId)).toMatchObject({ status: "submitted", submissionId: null });
    addGradingJob(classId, sub, "running");
    expect(entry(courseId)).toMatchObject({ status: "submitted", submissionId: null });
    addGradingJob(classId, sub, "failed");
    expect(entry(courseId)).toMatchObject({ status: "grading_failed", submissionId: sub });
  });

  it("goes back to submitted when the failed grading is restarted", () => {
    const courseId = addCourse(null);
    const classId = addClass(courseId, 1);
    const sub = addSubmission(addK(courseId, "K1", classId));
    addGradingJob(classId, sub, "failed");
    addGradingJob(classId, sub, "running");
    expect(entry(courseId).status).toBe("submitted");
  });

  it("looks at the latest submission only", () => {
    const courseId = addCourse(null);
    const classId = addClass(courseId, 1);
    const k1 = addK(courseId, "K1", classId);
    addGradingJob(classId, addSubmission(k1), "failed");
    const second = addSubmission(k1);
    expect(entry(courseId)).toMatchObject({ status: "submitted", submissionId: null });
    addGradingJob(classId, second, "failed");
    expect(entry(courseId)).toMatchObject({ status: "grading_failed", submissionId: second });
  });
});

describe("loadCumulativeContext", () => {
  it("collects the lessons, all non-deferred topics and the unresolved backlog of the covered classes", () => {
    const courseId = addCourse(2);
    const c1 = addClass(courseId, 1);
    const c2 = addClass(courseId, 2);
    const c3 = addClass(courseId, 3);
    const strong = addTopic(courseId, c1, 0, "Jaka tema", "✓");
    const weak = addTopic(courseId, c1, 1, "Slaba tema", "✗");
    const deferred = addTopic(courseId, c1, 2, "Odložena tema", "?", true);
    const other = addTopic(courseId, c2, 0, "Druga tema", "~");
    const later = addTopic(courseId, c3, 0, "Treća tema", "✗");
    db()
      .insert(topicEvent)
      .values({
        topicId: weak,
        source: "quiz",
        ref: "P01",
        outcome: "wrong",
        misconceptionText: "Zabluda",
      })
      .run();
    db()
      .insert(backlogItem)
      .values([
        { courseId, topicId: weak, dueQuiz: "K1", reason: "weak" },
        { courseId, topicId: strong, dueQuiz: "K1", reason: "left_out", resolvedAt: new Date() },
        { courseId, topicId: deferred, dueQuiz: "K1", reason: "left_out" },
        { courseId, topicId: other, dueQuiz: "K2", reason: "gap" },
        { courseId, topicId: later, dueQuiz: "K1", reason: "weak" },
      ])
      .run();

    const ctx = loadCumulativeContext(db(), courseId, "K1");
    expect(ctx).toMatchObject({
      kind: "cumulative",
      code: "K1",
      lessonMd: "",
      topics: [],
      class: { id: c2, number: 2 },
      coveredClasses: [
        { classNumber: 1, title: "Predavanje 1" },
        { classNumber: 2, title: "Predavanje 2" },
      ],
      course: { name: "Kurs", persona: "inženjer" },
    });
    expect(ctx.earlierLessons.map((l) => [l.classNumber, l.lessonMd])).toEqual([
      [1, "# Lekcija 1\n\nTekst 1."],
      [2, "# Lekcija 2\n\nTekst 2."],
    ]);
    // every non-deferred topic of the covered classes, with rating and history
    expect(ctx.earlierTopics.map((t) => [t.name, t.classNumber, t.rating])).toEqual([
      ["Jaka tema", 1, "✓"],
      ["Slaba tema", 1, "✗"],
      ["Druga tema", 2, "~"],
    ]);
    expect(ctx.earlierTopics[1]!.history).toEqual([
      { source: "quiz", ref: "P01", outcome: "wrong", misconception: "Zabluda", correction: null },
    ]);
    // unresolved items of covered classes only; the deferred one is marked
    expect(ctx.backlog.map((b) => [b.topic, b.classNumber, b.dueQuiz, b.deferred])).toEqual([
      ["Slaba tema", 1, "K1", false],
      ["Odložena tema", 1, "K1", true],
      ["Druga tema", 2, "K2", false],
    ]);
  });

  it("covers the ready classes up to the given class number", () => {
    const courseId = addCourse(2);
    addClass(courseId, 1);
    addClass(courseId, 2);
    addClass(courseId, 3);
    const ctx = loadCumulativeContext(db(), courseId, "K1", { coversThrough: 3 });
    expect(ctx.coveredClasses.map((c) => c.classNumber)).toEqual([1, 2, 3]);
    // the due K1 of cadence 2 stops at class 2 even though class 3 is ready
    expect(
      loadCumulativeContext(db(), courseId, "K1").coveredClasses.map((c) => c.classNumber),
    ).toEqual([1, 2]);
  });

  it("throws for an invalid code, a missing course or nothing to cover", () => {
    const courseId = addCourse(2);
    expect(() => loadCumulativeContext(db(), courseId, "P01")).toThrow(/not a cumulative code/);
    expect(() => loadCumulativeContext(db(), 999, "K1")).toThrow(/does not exist/);
    expect(() => loadCumulativeContext(db(), courseId, "K1", { coversThrough: 1 })).toThrow(
      /no ready class/,
    );
  });

  describe("size fallback", () => {
    it("leaves lessons alone below the limit", () => {
      const courseId = addCourse(2);
      addClass(courseId, 1);
      addClass(courseId, 2);
      const warn = vi.fn();
      const ctx = loadCumulativeContext(db(), courseId, "K1", {
        maxLessonChars: 1000,
        onWarn: warn,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(ctx.earlierLessons[0]!.lessonMd).toBe("# Lekcija 1\n\nTekst 1.");
    });

    it("cuts every lesson proportionally, lists the cut headings and warns", () => {
      const courseId = addCourse(2);
      const long = (n: number) =>
        `# Lekcija ${n}\n\n${"Prva rečenica broj. ".repeat(10)}\n\n## Kraj ${n}\n\n${"Rep teksta. ".repeat(30)}`;
      addClass(courseId, 1, { lesson: long(1) });
      addClass(courseId, 2, { lesson: long(2) });
      const total = long(1).length + long(2).length;
      const warn = vi.fn();
      const ctx = loadCumulativeContext(db(), courseId, "K1", {
        maxLessonChars: Math.floor(total / 2),
        onWarn: warn,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("each is cut to 50%");
      for (const l of ctx.earlierLessons) {
        expect(l.lessonMd.length).toBeLessThan(long(1).length * 0.75);
        expect(l.lessonMd).toContain("# Lekcija");
        expect(l.lessonMd).toContain("ostatak lekcije izostavljen");
        expect(l.lessonMd).toContain(`Kraj ${l.classNumber}`);
      }
      const sum = ctx.earlierLessons.reduce((acc, l) => acc + l.lessonMd.length, 0);
      expect(sum).toBeLessThan(total * 0.65);
    });
  });
});
