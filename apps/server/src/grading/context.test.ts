import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scoreQuiz, type Quiz, type QuizPlan, type SubmissionAnswers } from "@studdy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planFixture, quizFixture } from "../agents/testing/quiz-fixtures.js";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";
import {
  classTable,
  course,
  generationJob,
  lesson,
  quiz,
  quizPlan,
  submission,
  topic,
  topicEvent,
} from "../db/schema.js";
import { loadGradingContext, nextCumulativeCode } from "./context.js";

let dir: string;
let handle: DatabaseHandle;
let courseId: number;
let class2: number;
let quiz2: number;
let sub2: number;
let subNoPlan: number;
let subK: number;
let subSameName: number;
let subLegacy: number;
let subExact: number;
let subExact2: number;

const answers: SubmissionAnswers = {
  q1: 1,
  q2: 0,
  q3: "?",
  q4: 11,
  q5: { "0": 1, "1": "?", "2": 1 },
  q7: "Odgovor.",
  q8: "?",
};

function addClass(cId: number, number: number, title: string, withLesson = true): number {
  const { db } = handle;
  const cls = db
    .insert(classTable)
    .values({ courseId: cId, number, title, status: "ready" })
    .returning()
    .get();
  if (withLesson) {
    db.insert(lesson)
      .values({ classId: cls.id, bodyMd: `Lekcija ${number}` })
      .run();
  }
  return cls.id;
}

function addTopic(cId: number, classId: number, position: number, name: string): number {
  return handle.db
    .insert(topic)
    .values({ courseId: cId, classId, position, name, rating: "?" })
    .returning()
    .get().id;
}

function addQuiz(cId: number, classId: number | null, code: string, source: Quiz): number {
  return handle.db
    .insert(quiz)
    .values({
      courseId: cId,
      classId,
      code,
      title: source.title,
      subtitle: source.subtitle,
      chipsJson: source.chips,
      questionsJson: source.questions,
    })
    .returning()
    .get().id;
}

function addPlan(classId: number, quizId: number, plan: QuizPlan): void {
  const { db } = handle;
  const job = db
    .insert(generationJob)
    .values({ classId, kind: "quiz", stage: "quiz-planner", status: "succeeded", attempt: 1 })
    .returning()
    .get();
  db.insert(quizPlan).values({ jobId: job.id, classId, planJson: plan, logJson: [], quizId }).run();
}

function addSubmission(quizId: number, source: Quiz): number {
  const score = scoreQuiz(source, answers);
  return handle.db
    .insert(submission)
    .values({
      quizId,
      answersJson: answers,
      autoScore: score.autoScore,
      autoMax: score.autoMax,
      dontKnowJson: score.dontKnow,
      resultsJson: score.results,
      openPending: score.openPending,
    })
    .returning()
    .get().id;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-gradectx-test-"));
  handle = openDatabase(dir);
  migrate(handle.db);
  const { db } = handle;

  courseId = db
    .insert(course)
    .values({
      name: "Kurs",
      persona: "inženjer",
      assessmentFormat: "Usmeni ispit",
      reviewCadence: 4,
    })
    .returning()
    .get().id;
  const class1 = addClass(courseId, 1, "Skladišta");
  class2 = addClass(courseId, 2, "Obrada podataka");

  const warehouse = addTopic(courseId, class1, 0, "Skladišta podataka");
  addTopic(courseId, class1, 1, "Batch obrada"); // same name as a class 2 topic
  const batch = addTopic(courseId, class2, 0, "Batch obrada");
  addTopic(courseId, class2, 1, "Stream obrada");
  addTopic(courseId, class2, 2, "Lambda arhitektura");
  db.insert(topicEvent)
    .values([
      {
        topicId: warehouse,
        source: "quiz",
        ref: "P01",
        outcome: "wrong",
        misconceptionText: "Lake je isto što i warehouse",
      },
      {
        topicId: batch,
        source: "notes",
        outcome: "misconception",
        misconceptionText: "Batch je uvek sporiji",
        correctionText: "Batch optimizuje propusnost.",
      },
    ])
    .run();

  const quizSource = quizFixture();
  quiz2 = addQuiz(courseId, class2, "P02", quizSource);
  addPlan(class2, quiz2, planFixture());
  sub2 = addSubmission(quiz2, quizSource);

  // A second quiz of the same class without a plan: the repeat falls back to the earlier class.
  const noPlan = addQuiz(courseId, class2, "P02R", { ...quizSource, code: "P02R" });
  subNoPlan = addSubmission(noPlan, quizSource);

  // A cumulative quiz (no class).
  const cumulative = addQuiz(courseId, null, "K1", { ...quizSource, code: "K1" });
  subK = addSubmission(cumulative, quizSource);

  // A repeat whose name also exists in the current class resolves to the earlier class.
  const sameName = quizFixture();
  sameName.code = "P02S";
  sameName.questions[5]!.topic = "Batch obrada";
  const samePlan = planFixture();
  samePlan.questions[5]!.topic = "Batch obrada";
  samePlan.questions[5]!.classNumber = 1;
  const sameNameQuiz = addQuiz(courseId, class2, "P02S", sameName);
  addPlan(class2, sameNameQuiz, samePlan);
  subSameName = addSubmission(sameNameQuiz, sameName);

  // A plan stored before classNumber existed: the field is missing, the heuristic applies.
  const legacy = quizFixture();
  legacy.code = "P02L";
  const legacyPlan = planFixture();
  for (const q of legacyPlan.questions) delete (q as { classNumber?: unknown }).classNumber;
  const legacyQuiz = addQuiz(courseId, class2, "P02L", legacy);
  addPlan(class2, legacyQuiz, legacyPlan);
  subLegacy = addSubmission(legacyQuiz, legacy);

  // Two earlier classes share a topic name; the plan's classNumber picks the older one although
  // the heuristic would pick the most recent.
  const course2 = db.insert(course).values({ name: "Drugi kurs" }).returning().get().id;
  const c2class1 = addClass(course2, 1, "Prvo");
  const c2class2 = addClass(course2, 2, "Drugo");
  const c2class3 = addClass(course2, 3, "Treće");
  addTopic(course2, c2class1, 0, "Deljena tema");
  addTopic(course2, c2class2, 0, "Deljena tema");
  addTopic(course2, c2class3, 0, "Batch obrada");
  const exact = quizFixture();
  exact.code = "P03";
  exact.questions = [
    { ...exact.questions[0]!, topic: "Batch obrada" },
    { ...exact.questions[5]!, id: "q6", topic: "Deljena tema" },
  ];
  const exactPlan = planFixture();
  exactPlan.questions = [
    exactPlan.questions[0]!,
    { ...exactPlan.questions[5]!, topic: "Deljena tema", classNumber: 1 },
  ];
  exactPlan.leftOut = [];
  const exactQuiz = addQuiz(course2, c2class3, "P03", exact);
  addPlan(c2class3, exactQuiz, exactPlan);
  subExact = addSubmission(exactQuiz, exact);
  const exactPlan2 = structuredClone(exactPlan);
  exactPlan2.questions[1]!.classNumber = 2;
  const exactQuiz2 = addQuiz(course2, c2class3, "P03B", { ...exact, code: "P03B" });
  addPlan(c2class3, exactQuiz2, exactPlan2);
  subExact2 = addSubmission(exactQuiz2, exact);
});

afterAll(() => {
  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("nextCumulativeCode", () => {
  it("is ceil(class / cadence), or K1 without a cadence", () => {
    expect(nextCumulativeCode(1, 4)).toBe("K1");
    expect(nextCumulativeCode(4, 4)).toBe("K1");
    expect(nextCumulativeCode(5, 4)).toBe("K2");
    expect(nextCumulativeCode(9, 4)).toBe("K3");
    expect(nextCumulativeCode(7, null)).toBe("K1");
  });
});

describe("loadGradingContext", () => {
  it("loads the course, quiz, plan and the submission with its results", () => {
    const ctx = loadGradingContext(handle.db, sub2);
    expect(ctx.course).toEqual({
      id: courseId,
      name: "Kurs",
      persona: "inženjer",
      assessmentFormat: "Usmeni ispit",
      reviewCadence: 4,
    });
    expect(ctx.quiz).toMatchObject({ id: quiz2, classId: class2, code: "P02" });
    expect(ctx.quiz.questions).toHaveLength(8);
    expect(ctx.plan).toEqual(planFixture());
    expect(ctx.submission.id).toBe(sub2);
    expect(ctx.submission.answers).toEqual(answers);
    const expected = scoreQuiz(quizFixture(), answers);
    expect(ctx.submission.results).toEqual(expected.results);
    expect(ctx.submission).toMatchObject({
      autoScore: expected.autoScore,
      autoMax: expected.autoMax,
      dontKnow: expected.dontKnow,
    });
    expect(new Date(ctx.submission.submittedAt).toString()).not.toBe("Invalid Date");
    expect(ctx.observations).toEqual([]);
    expect(ctx.backlog).toEqual([]);
    expect(ctx.nextSteps).toEqual([]);
  });

  it("resolves current topics by name and repeats to the earlier class", () => {
    const ctx = loadGradingContext(handle.db, sub2);
    expect(ctx.topics.map((t) => [t.name, t.classNumber])).toEqual([
      ["Batch obrada", 2],
      ["Stream obrada", 2],
      ["Skladišta podataka", 1],
    ]);
    expect(ctx.topics[0]!.history).toEqual([
      {
        source: "notes",
        ref: null,
        outcome: "misconception",
        misconception: "Batch je uvek sporiji",
        correction: "Batch optimizuje propusnost.",
      },
    ]);
    expect(ctx.topics[2]!.history[0]).toMatchObject({ source: "quiz", ref: "P01" });
    expect(ctx.questionTopics).toContainEqual({
      questionId: "q6",
      topic: "Skladišta podataka",
      classNumber: 1,
    });
    expect(ctx.questionTopics).toContainEqual({
      questionId: "q1",
      topic: "Batch obrada",
      classNumber: 2,
    });
  });

  it("pulls the lessons of the quiz's class and of the repeat topics' classes", () => {
    const ctx = loadGradingContext(handle.db, sub2);
    expect(ctx.lessons).toEqual([
      { classNumber: 1, title: "Skladišta", lessonMd: "Lekcija 1" },
      { classNumber: 2, title: "Obrada podataka", lessonMd: "Lekcija 2" },
    ]);
  });

  it("resolves the plan's left-out topics", () => {
    const ctx = loadGradingContext(handle.db, sub2);
    expect(ctx.leftOutTopics).toHaveLength(1);
    expect(ctx.leftOutTopics[0]).toMatchObject({
      name: "Lambda arhitektura",
      classNumber: 2,
      reason: "Odloženo, tema nije obrađena.",
    });
  });

  it("derives the next cumulative code from the class number and the cadence", () => {
    expect(loadGradingContext(handle.db, sub2).nextCumulativeCode).toBe("K1");
    handle.db.update(course).set({ reviewCadence: 1 }).run();
    expect(loadGradingContext(handle.db, sub2).nextCumulativeCode).toBe("K2");
    handle.db.update(course).set({ reviewCadence: null }).run();
    expect(loadGradingContext(handle.db, sub2).nextCumulativeCode).toBe("K1");
    handle.db.update(course).set({ reviewCadence: 4 }).run();
  });

  it("resolves a repeat to the earlier class even when the current class has the same topic name", () => {
    const ctx = loadGradingContext(handle.db, subSameName);
    expect(ctx.topics.map((t) => [t.name, t.classNumber])).toEqual([
      ["Batch obrada", 2],
      ["Stream obrada", 2],
      ["Batch obrada", 1],
    ]);
    expect(ctx.questionTopics.find((t) => t.questionId === "q6")).toEqual({
      questionId: "q6",
      topic: "Batch obrada",
      classNumber: 1,
    });
  });

  it("uses the plan's classNumber to pick the topic when two earlier classes share its name", () => {
    const pick = (id: number) =>
      loadGradingContext(handle.db, id).questionTopics.find((t) => t.questionId === "q6");
    expect(pick(subExact)).toEqual({ questionId: "q6", topic: "Deljena tema", classNumber: 1 });
    expect(pick(subExact2)).toEqual({ questionId: "q6", topic: "Deljena tema", classNumber: 2 });
  });

  it("falls back to the most-recent-class heuristic for plans without classNumber", () => {
    const ctx = loadGradingContext(handle.db, subLegacy);
    expect(ctx.questionTopics.find((t) => t.questionId === "q6")).toEqual({
      questionId: "q6",
      topic: "Skladišta podataka",
      classNumber: 1,
    });
  });

  it("works without a plan: no plan, no left-out topics, repeats found in earlier classes", () => {
    const ctx = loadGradingContext(handle.db, subNoPlan);
    expect(ctx.plan).toBeNull();
    expect(ctx.leftOutTopics).toEqual([]);
    // Without the plan the repeat flag is unknown, so the name is looked up in the current class
    // first and then in earlier ones.
    expect(ctx.topics.map((t) => [t.name, t.classNumber])).toEqual([
      ["Batch obrada", 2],
      ["Stream obrada", 2],
      ["Skladišta podataka", 1],
    ]);
  });

  it("loads a cumulative quiz, which belongs to no class", () => {
    const ctx = loadGradingContext(handle.db, subK);
    expect(ctx.quiz.classId).toBeNull();
    expect(ctx.plan).toBeNull();
    // Looked up through all classes, most recent first; the latest class is 2.
    expect(ctx.topics.map((t) => [t.name, t.classNumber])).toEqual([
      ["Batch obrada", 2],
      ["Stream obrada", 2],
      ["Skladišta podataka", 1],
    ]);
    expect(ctx.lessons.map((l) => l.classNumber)).toEqual([1, 2]);
    expect(ctx.nextCumulativeCode).toBe("K1");
  });

  it("throws for a missing submission", () => {
    expect(() => loadGradingContext(handle.db, 9999)).toThrow(/does not exist/);
  });
});
