import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApiErrorBody,
  GenerationJob,
  ClassJobs,
  QuizSummary,
  type LessonDraft,
  type QuizReview,
} from "@studdy/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ResilientRunner } from "../agents/resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "../agents/runtime.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponder } from "../agents/testing/fake-runner.js";
import { MISCONCEPTION, planFixture, quizFixture } from "../agents/testing/quiz-fixtures.js";
import {
  classTable,
  course,
  generationJob,
  lesson,
  material,
  quiz,
  quizPlan,
  topic,
} from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";

const LESSON: LessonDraft = {
  lessonMd:
    "Obrada podataka.\n\n## Batch obrada\n\n- Batch optimizuje propusnost.\n\n> ⚠️ Ispravka: batch nije uvek sporiji.",
  topics: [
    {
      name: "Batch obrada",
      misconceptions: [
        { claim: MISCONCEPTION, correction: "Batch optimizuje propusnost, ne latenciju." },
      ],
      deferred: false,
      deferredNote: null,
    },
    { name: "Stream obrada", misconceptions: [], deferred: false, deferredNote: null },
    {
      name: "Lambda arhitektura",
      misconceptions: [],
      deferred: true,
      deferredNote: "Na sledećem času.",
    },
  ],
};
const APPROVED: QuizReview = { approved: true, summary: "Sve je u redu.", fixes: [] };
const REJECTED: QuizReview = {
  approved: false,
  summary: "Loš ključ odgovora.",
  fixes: [{ questionId: "q3", problem: "Dve opcije su tačne.", change: "Zameni opciju 2." }],
};

let responder: FakeResponder;
let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-quiz-routes-test-"));
  const inner = new FakeRunner((input, i) => responder(input, i));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("quiz routes", () => {
  let t: TestApp;
  let courseId: number;
  let classId: number;

  beforeEach(() => {
    t = createTestApp({ pipeline: {} });
    courseId = t.handle.db
      .insert(course)
      .values({ name: "Kurs" })
      .returning({ id: course.id })
      .get().id;
    classId = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 2, title: "Obrada podataka" })
      .returning({ id: classTable.id })
      .get().id;
    // class 1 has a lesson with a weak topic, which the quiz of class 2 repeats
    const first = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 1, title: "Uvod", status: "ready" })
      .returning({ id: classTable.id })
      .get().id;
    t.handle.db.insert(lesson).values({ classId: first, bodyMd: "Uvod." }).run();
    t.handle.db
      .insert(topic)
      .values({
        courseId,
        classId: first,
        name: "Skladišta podataka",
        position: 0,
        rating: "✗",
      })
      .run();
    t.handle.db
      .insert(material)
      .values({
        classId,
        kind: "material",
        originalName: "slajdovi.pdf",
        mime: "application/pdf",
        sizeBytes: 10,
        sha256: "h",
        storagePath: "files/h/h.pdf",
        extractedText: "--- strana 1 ---\n## Batch obrada",
        extractionStatus: "ok",
      })
      .run();
    t.handle.db
      .insert(material)
      .values({
        classId,
        kind: "note",
        originalName: "beleske.md",
        mime: "text/markdown",
        sizeBytes: 10,
        sha256: "n",
        storagePath: "files/n/n.md",
        extractedText: "Batch je uvek sporiji.",
        extractionStatus: "ok",
      })
      .run();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const post = (url: string) => t.app.inject({ method: "POST", url });
  const get = async (url: string) => {
    const res = await t.app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const jobsOf = async () => ClassJobs.parse((await get(`/api/classes/${classId}/jobs`)).body).jobs;

  /** Lesson, plan, draft and review answers by structured-output name. */
  function script(reviews: QuizReview[]): { calls: string[] } {
    const calls: string[] = [];
    let reviewIndex = 0;
    responder = (input) => {
      const name = (input as { structuredOutput?: { name?: string } }).structuredOutput?.name ?? "";
      calls.push(name);
      switch (name) {
        case "lesson_draft":
          return fakeJsonAnswer(LESSON);
        case "quiz_plan":
          return fakeJsonAnswer(planFixture());
        case "quiz_draft":
          return fakeJsonAnswer({ quiz: quizFixture(), flags: [] });
        case "quiz_review":
          return fakeJsonAnswer(reviews[Math.min(reviewIndex++, reviews.length - 1)]);
        default:
          return new Error(`unexpected call ${name}`);
      }
    };
    return { calls };
  }

  it("runs lesson, plan, build and review end to end and lists the released quiz", async () => {
    const { calls } = script([APPROVED]);
    expect((await post(`/api/classes/${classId}/generate`)).statusCode).toBe(202);

    await waitFor(
      async () => (await jobsOf()).filter((j) => j.status === "succeeded").length === 2,
    );
    expect(calls).toEqual(["lesson_draft", "quiz_plan", "quiz_draft", "quiz_review"]);
    const jobs = await jobsOf();
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([
      ["quiz", "succeeded"],
      ["lesson", "succeeded"],
    ]);
    expect(jobs[0]).toMatchObject({ attempt: 1, cycle: 1 });

    const res = await get(`/api/courses/${courseId}/quizzes`);
    expect(res.status).toBe(200);
    const summaries = (res.body as unknown[]).map((q) => QuizSummary.parse(q));
    expect(summaries).toEqual([
      {
        id: expect.any(Number),
        courseId,
        classId,
        code: "P02",
        title: "Obrada podataka",
        subtitle: "Predavanje 2",
        chips: quizFixture().chips,
        questionCount: 8,
        createdAt: expect.any(String),
      },
    ]);
    // no questions, answers or plan anywhere in the response
    const raw = JSON.stringify(res.body);
    expect(Object.keys((res.body as object[])[0]!).sort()).toEqual(
      Object.keys(summaries[0]!).sort(),
    );
    expect(raw).not.toMatch(/questions|keyPoints|mcCorrectIndex|explanation|planJson/);
    expect(((await get(`/api/classes/${classId}`)).body as { status: string }).status).toBe(
      "ready",
    );
  });

  it("returns an empty list, 404 for an unknown course and 400 for a bad id", async () => {
    expect((await get(`/api/courses/${courseId}/quizzes`)).body).toEqual([]);
    expect((await get("/api/courses/9999/quizzes")).status).toBe(404);
    expect((await get("/api/courses/abc/quizzes")).status).toBe(400);
  });

  it("lists quizzes newest first", () => {
    for (const code of ["P01", "P02"]) {
      t.handle.db
        .insert(quiz)
        .values({
          courseId,
          classId: null,
          code,
          title: code,
          subtitle: "S",
          chipsJson: [],
          questionsJson: [],
        })
        .run();
    }
    return get(`/api/courses/${courseId}/quizzes`).then((res) => {
      expect((res.body as { code: string }[]).map((q) => q.code)).toEqual(["P02", "P01"]);
    });
  });

  it("offers regeneration after a failed review and releases on the second try", async () => {
    script([REJECTED]);
    await post(`/api/classes/${classId}/generate`);
    await waitFor(async () =>
      (await jobsOf()).some((j) => j.kind === "quiz" && j.status === "failed"),
    );
    const failed = (await jobsOf()).find((j) => j.kind === "quiz")!;
    expect(failed.error).toMatch(
      /^Quiz review did not pass after 3 fix cycles: Loš ključ odgovora/,
    );
    expect((await get(`/api/courses/${courseId}/quizzes`)).body).toEqual([]);
    expect(((await get(`/api/classes/${classId}`)).body as { status: string }).status).toBe(
      "ready",
    );

    const { calls } = script([APPROVED]);
    const res = await post(`/api/classes/${classId}/quiz/regenerate`);
    expect(res.statusCode).toBe(202);
    expect(GenerationJob.parse(res.json())).toMatchObject({
      kind: "quiz",
      attempt: 2,
      status: "running",
      stage: "quiz-planner",
    });
    await waitFor(
      async () => ((await get(`/api/courses/${courseId}/quizzes`)).body as unknown[]).length === 1,
    );
    expect(calls).toEqual(["quiz_plan", "quiz_draft", "quiz_review"]);
    expect(t.handle.db.select().from(quizPlan).all()).toHaveLength(2);
    const parent = t.handle.db
      .select()
      .from(generationJob)
      .where(eq(generationJob.id, GenerationJob.parse(res.json()).id))
      .get()!.parentJobId;
    expect(parent).toBe(failed.id);

    const again = await post(`/api/classes/${classId}/quiz/regenerate`);
    expect(again.statusCode).toBe(409);
    expect(ApiErrorBody.parse(again.json()).error.code).toBe("conflict");
  });

  it("answers the regenerate endpoint with 404, 409 and 400", async () => {
    expect((await post("/api/classes/9999/quiz/regenerate")).statusCode).toBe(404);
    expect((await post("/api/classes/abc/quiz/regenerate")).statusCode).toBe(400);
    // the class is still a draft, with no quiz job
    const res = await post(`/api/classes/${classId}/quiz/regenerate`);
    expect(res.statusCode).toBe(409);
    expect(ApiErrorBody.parse(res.json()).error.code).toBe("conflict");
  });
});
