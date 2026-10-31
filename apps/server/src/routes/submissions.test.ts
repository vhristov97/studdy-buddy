import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApiErrorBody,
  PublicQuiz,
  Quiz,
  SubmissionDetail,
  SubmissionSummary,
  type SubmissionAnswers,
  scoreQuiz,
} from "@studdy/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ResilientRunner } from "../agents/resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "../agents/runtime.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { classTable, course, quiz, submission } from "../db/schema.js";
import { DOMAIN_EVENTS, type SubmissionCreatedPayload } from "../pipeline/events.js";
import { createTestApp, type TestApp } from "../test/app.js";

let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-submissions-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new ResilientRunner(new FakeRunner(() => new Error("no agents expected")), {
      onFailure: publishStageFailed,
      sleep: async () => {},
    }),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

const FULL = Quiz.parse({
  code: "P01",
  title: "Uvod u batch obradu",
  subtitle: "Predavanje 1",
  chips: ["batch", "stream"],
  questions: [
    {
      id: "q1",
      type: "mc",
      topic: "Batch obrada",
      prompt: "Šta optimizuje batch?",
      ref: "Batch › Uvod",
      extra: false,
      options: ["Latenciju", "Propusnost", "Memoriju"],
      answer: 1,
      explanation: "Batch optimizuje propusnost.",
    },
    {
      id: "q2",
      type: "num",
      topic: "Batch obrada",
      prompt: "Koliko traje job?",
      ref: "Batch › Primer (predavač)",
      extra: true,
      answer: 12.5,
      tolerance: 0.5,
      unit: "min",
      explanation: "12.5 minuta.",
    },
    {
      id: "q3",
      type: "match",
      topic: "Stream obrada",
      prompt: "Poveži pojmove.",
      ref: "Stream › Pojmovi",
      extra: false,
      rows: ["Kafka", "Spark"],
      choices: ["Obrada", "Log"],
      answer: [1, 0],
      explanation: "Kafka je log, Spark obrada.",
    },
    {
      id: "q4",
      type: "open",
      topic: "Stream obrada",
      prompt: "Objasni razliku.",
      ref: "Stream › Razlika",
      extra: false,
      keyPoints: ["Latencija", "Propusnost"],
    },
  ],
});
// q1 mc (answer 1), q2 num (12.5 +- 0.5), q3 match ([1, 0]), q4 open

const SECRET_KEYS = ["answer", "explanation", "keyPoints", "tolerance"];
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe("quiz player and submission routes", () => {
  let t: TestApp;
  let courseId: number;
  let quizId: number;

  beforeEach(async () => {
    t = createTestApp({ pipeline: { gradingAutoStart: false } });
    courseId = t.handle.db
      .insert(course)
      .values({ name: "Kurs za test" })
      .returning({ id: course.id })
      .get().id;
    const classId = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 1, title: "Uvod" })
      .returning({ id: classTable.id })
      .get().id;
    quizId = t.handle.db
      .insert(quiz)
      .values({
        courseId,
        classId,
        code: FULL.code,
        title: FULL.title,
        subtitle: FULL.subtitle,
        chipsJson: FULL.chips,
        questionsJson: FULL.questions,
      })
      .returning({ id: quiz.id })
      .get().id;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const get = async (url: string) => {
    const res = await t.app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const post = async (url: string, payload: unknown) => {
    const res = await t.app.inject({ method: "POST", url, payload: payload as object });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const submit = (answers: unknown) => post(`/api/quizzes/${quizId}/submissions`, { answers });
  const errorOf = (body: unknown) => ApiErrorBody.parse(body).error;

  describe("GET /api/quizzes/:quizId", () => {
    it("returns the public quiz with no answers of any type", async () => {
      const res = await get(`/api/quizzes/${quizId}`);
      expect(res.status).toBe(200);
      const pub = PublicQuiz.parse(res.body);
      expect(pub).toMatchObject({
        id: quizId,
        courseId,
        courseName: "Kurs za test",
        code: "P01",
        title: FULL.title,
        subtitle: FULL.subtitle,
        chips: FULL.chips,
      });
      expect(pub.classId).toEqual(expect.any(Number));
      expect(pub.questions.map((q) => q.type)).toEqual(["mc", "num", "match", "open"]);
      expect(pub.questions[0]).toMatchObject({ options: ["Latenciju", "Propusnost", "Memoriju"] });
      expect(pub.questions[1]).toMatchObject({ unit: "min" });
      expect(pub.questions[2]).toMatchObject({
        rows: ["Kafka", "Spark"],
        choices: ["Obrada", "Log"],
      });

      const keys = keysDeep(res.body);
      for (const secret of SECRET_KEYS) expect(keys.has(secret), secret).toBe(false);
      // none of the secret values either
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain("Batch optimizuje propusnost.");
      expect(raw).not.toContain("Latencija");
    });

    it("answers 404 for an unknown quiz and 400 for a bad id", async () => {
      expect(errorOf((await get("/api/quizzes/9999")).body).code).toBe("not_found");
      expect((await get("/api/quizzes/abc")).status).toBe(400);
    });
  });

  describe("POST /api/quizzes/:quizId/submissions", () => {
    const ANSWERS: SubmissionAnswers = {
      q1: 1,
      q2: 14,
      q3: { "0": 1, "1": "?" },
      q4: "Moj odgovor",
    };

    it("scores on the server, stores the submission and returns the feedback", async () => {
      const res = await submit(ANSWERS);
      expect(res.status).toBe(201);
      const detail = SubmissionDetail.parse(res.body);
      expect(detail).toMatchObject({
        quizId,
        autoScore: 1.5,
        autoMax: 3,
        openPending: 1,
        dontKnow: ["q3.r2"],
        answers: ANSWERS,
      });
      expect(detail.results.map((r) => [r.id, r.status])).toEqual([
        ["q1", "correct"],
        ["q2", "wrong"],
        ["q3", "partial"],
        ["q4", "open_pending"],
      ]);
      expect(detail.feedback.questions).toHaveLength(4);
      expect(detail.feedback.questions[0]).toMatchObject({ type: "mc", answer: 1 });
      expect(detail.feedback.questions[3]).toMatchObject({ type: "open" });

      const row = t.handle.db.select().from(submission).where(eq(submission.id, detail.id)).get()!;
      expect(row).toMatchObject({ quizId, autoScore: 1.5, autoMax: 3, openPending: 1 });
      expect(row.answersJson).toEqual(ANSWERS);
      expect(row.dontKnowJson).toEqual(["q3.r2"]);
      expect(row.resultsJson).toEqual(scoreQuiz(FULL, ANSWERS).results);
    });

    it("scores a submission of only wrong answers zero", async () => {
      const detail = SubmissionDetail.parse((await submit({ q1: 0 })).body);
      expect(detail).toMatchObject({ autoScore: 0, autoMax: 3, openPending: 0, dontKnow: [] });
    });

    it("rejects a submission where no question has a value", async () => {
      for (const answers of [{}, { q4: "   " }, { q3: {} }, { q4: "", q3: {} }]) {
        const res = await submit(answers);
        expect(res.status).toBe(400);
        const error = errorOf(res.body);
        expect(error.code).toBe("validation");
        expect(error.message).toBe("Nijedno pitanje nije odgovoreno.");
      }
      expect(t.handle.db.select().from(submission).all()).toEqual([]);
    });

    it("accepts Ne znam as an answer", async () => {
      const res = await submit({ q1: "?" });
      expect(res.status).toBe(201);
      expect(SubmissionDetail.parse(res.body).dontKnow).toEqual(["q1"]);
    });

    it("emits submission.created", async () => {
      const seen: SubmissionCreatedPayload[] = [];
      t.coordinator!.on<SubmissionCreatedPayload>(DOMAIN_EVENTS.SUBMISSION_CREATED, (p) => {
        seen.push(p);
      });
      const detail = SubmissionDetail.parse((await submit({ q1: 1 })).body);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([{ quizId, submissionId: detail.id }]);
    });

    it("saves the submission even when the event cannot be emitted", async () => {
      t.coordinator!.stop();
      const res = await submit({ q1: 1 });
      expect(res.status).toBe(201);
      expect(t.handle.db.select().from(submission).all()).toHaveLength(1);
    });

    it("rejects invalid answers with a 400 listing the problems", async () => {
      const res = await submit({ q1: 7, q9: 1, q3: { "5": 0 } });
      expect(res.status).toBe(400);
      const error = errorOf(res.body);
      expect(error.code).toBe("validation");
      expect(error.details).toEqual([
        "q1: option 7 is out of range",
        "q9: unknown question",
        "q3: row 5 is out of range",
      ]);
      expect(t.handle.db.select().from(submission).all()).toEqual([]);
    });

    it("rejects malformed bodies", async () => {
      expect((await post(`/api/quizzes/${quizId}/submissions`, {})).status).toBe(400);
      expect((await submit({ q1: null })).status).toBe(400);
      expect((await submit({ q1: "text" })).status).toBe(400);
      expect((await submit([1, 2])).status).toBe(400);
      expect((await submit({ q4: "a".repeat(20001) })).status).toBe(400);
    });

    it("ignores any client score: extra fields are rejected and nothing is stored", async () => {
      const res = await post(`/api/quizzes/${quizId}/submissions`, {
        answers: { q1: 0 },
        autoScore: 3,
        autoMax: 3,
        dontKnow: [],
      });
      expect(res.status).toBe(400);
      expect(t.handle.db.select().from(submission).all()).toEqual([]);

      // an honest submission is scored from the answers alone
      const detail = SubmissionDetail.parse((await submit({ q1: 0 })).body);
      expect(detail.autoScore).toBe(0);
    });

    it("answers 404 for an unknown quiz", async () => {
      const res = await post("/api/quizzes/9999/submissions", { answers: {} });
      expect(res.status).toBe(404);
      expect(errorOf(res.body).code).toBe("not_found");
    });
  });

  describe("reading submissions", () => {
    it("lists submissions newest first and returns the detail with feedback", async () => {
      const first = SubmissionDetail.parse((await submit({ q1: 0 })).body);
      const second = SubmissionDetail.parse((await submit({ q1: 1, q2: "?" })).body);

      const list = await get(`/api/quizzes/${quizId}/submissions`);
      expect(list.status).toBe(200);
      const summaries = (list.body as unknown[]).map((s) => SubmissionSummary.parse(s));
      expect(summaries.map((s) => s.id)).toEqual([second.id, first.id]);
      expect(summaries[0]).toMatchObject({ autoScore: 1, dontKnow: ["q2"] });
      // summaries carry no answers or feedback
      const keys = keysDeep(list.body);
      for (const key of ["answers", "feedback", "results", ...SECRET_KEYS]) {
        expect(keys.has(key), key).toBe(false);
      }

      const detail = await get(`/api/submissions/${second.id}`);
      expect(detail.status).toBe(200);
      expect(SubmissionDetail.parse(detail.body)).toEqual(second);
    });

    it("answers 404 and 400 for unknown or bad ids", async () => {
      expect((await get("/api/submissions/9999")).status).toBe(404);
      expect((await get("/api/submissions/abc")).status).toBe(400);
      expect((await get("/api/quizzes/9999/submissions")).status).toBe(404);
      expect((await get(`/api/quizzes/${quizId}/submissions`)).body).toEqual([]);
    });

    it("keeps feedback out of the quiz GET even after a submission", async () => {
      await submit({ q1: 1 });
      const keys = keysDeep((await get(`/api/quizzes/${quizId}`)).body);
      for (const secret of SECRET_KEYS) expect(keys.has(secret)).toBe(false);
    });
  });
});
