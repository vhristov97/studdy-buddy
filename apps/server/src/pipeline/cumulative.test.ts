import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { and, eq } from "drizzle-orm";
import {
  CourseProgress,
  CumulativeStatus,
  type PipelineEvent,
  type QuizDraft,
  type QuizReview,
} from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentRuntime } from "../agents/runtime.js";
import { StageError, type StageSession } from "../agents/stage.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { gradingResultFixture } from "../agents/testing/grading-fixtures.js";
import { cumulativePlanFixture, quizFixture } from "../agents/testing/quiz-fixtures.js";
import {
  backlogItem,
  classTable,
  course,
  generationJob,
  lesson,
  quiz,
  quizPlan,
  result,
  submission,
  topic,
} from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { DOMAIN_EVENTS, type QuizReleasedPayload } from "./events.js";
import type { QuizAgents } from "./quiz-branch.js";

const APPROVED: QuizReview = { approved: true, summary: "Sve je u redu.", fixes: [] };
const REJECTED: QuizReview = {
  approved: false,
  summary: "Pitanje ima dva tačna odgovora.",
  fixes: [{ questionId: "q3", problem: "Dve opcije su tačne.", change: "Zameni opciju 2." }],
};

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-cumulative-branch-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("cumulative review branch", () => {
  let t: TestApp;
  let events: SemanticEvent[];
  let courseId: number;
  let classIds: number[];
  let plan: ReturnType<typeof vi.fn<QuizAgents["planQuiz"]>>;
  let review: ReturnType<typeof vi.fn<QuizAgents["reviewQuiz"]>>;
  let send: ReturnType<typeof vi.fn<(message: string) => Promise<QuizDraft>>>;
  let open: ReturnType<typeof vi.fn<QuizAgents["openQuizBuilderSession"]>>;

  const db = () => t.handle.db;
  const kJobs = () =>
    db()
      .select()
      .from(generationJob)
      .all()
      .filter((j) => j.kind === "quiz" && j.quizCode !== null);
  const finished = (n = 1) => kJobs().length >= n && kJobs().every((j) => j.status !== "running");
  const post = (body?: unknown, id = courseId) =>
    t.app.inject({
      method: "POST",
      url: `/api/courses/${id}/cumulative`,
      ...(body !== undefined && { payload: body as object }),
    });
  const status = async () =>
    CumulativeStatus.parse(
      (await t.app.inject({ method: "GET", url: `/api/courses/${courseId}/cumulative` })).json(),
    );
  const progress = async () =>
    CourseProgress.parse(
      (await t.app.inject({ method: "GET", url: `/api/courses/${courseId}/progress` })).json(),
    );

  function addClasses(count: number): void {
    for (let number = classIds.length + 1; number <= count; number++) {
      const id = db()
        .insert(classTable)
        .values({ courseId, number, title: `Predavanje ${number}`, status: "ready" })
        .returning({ id: classTable.id })
        .get().id;
      db()
        .insert(lesson)
        .values({ classId: id, bodyMd: `LEKCIJA-${number}` })
        .run();
      db()
        .insert(topic)
        .values({ courseId, classId: id, position: 0, name: `Tema ${number}`, rating: "?" })
        .run();
      classIds.push(id);
    }
  }

  beforeEach(() => {
    plan = vi.fn<QuizAgents["planQuiz"]>(async (ctx) => ({
      ...cumulativePlanFixture(),
      code: ctx.code,
    }));
    review = vi.fn<QuizAgents["reviewQuiz"]>(async () => APPROVED);
    send = vi.fn();
    open = vi.fn<QuizAgents["openQuizBuilderSession"]>((p) => {
      send.mockImplementation(async () => ({
        quiz: { ...quizFixture(), code: p.code },
        flags: [],
      }));
      return { send, close: vi.fn() } as unknown as StageSession<QuizDraft>;
    });
    t = createTestApp({
      pipeline: {
        quizAgents: { planQuiz: plan, openQuizBuilderSession: open, reviewQuiz: review },
        quizAutoStart: false,
        gradingAutoStart: false,
        vizAutoStart: false,
      },
    });
    events = [];
    t.coordinator!.subscribe((e) => events.push(e));
    courseId = db()
      .insert(course)
      .values({ name: "Kurs", reviewCadence: 2 })
      .returning({ id: course.id })
      .get().id;
    classIds = [];
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("builds and releases the due K1 with class_id null, over the lessons of the covered classes", async () => {
    addClasses(3);
    expect((await status()).due).toEqual({ code: "K1", coversThrough: 2, classNumbers: [1, 2] });
    expect((await progress()).flags.cumulativeDue).toEqual({ code: "K1", coversThrough: 2 });

    const response = await post();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      kind: "quiz",
      quizCode: "K1",
      classId: classIds[1],
      status: "running",
      stage: "quiz-planner",
      attempt: 1,
    });
    await waitFor(() => events.some((e) => e.type === DOMAIN_EVENTS.QUIZ_RELEASED));

    // the planner saw a cumulative context over classes 1..2 (class 3 is not covered)
    const ctx = plan.mock.calls[0]![0];
    expect(ctx).toMatchObject({ kind: "cumulative", code: "K1", class: { number: 2 } });
    expect(ctx.earlierLessons.map((l) => l.lessonMd)).toEqual(["LEKCIJA-1", "LEKCIJA-2"]);
    // the builder and reviewer got the same lessons and no current-class lesson
    const builderMessage = send.mock.calls[0]![0];
    expect(builderMessage).toContain("LEKCIJA-1");
    expect(builderMessage).toContain("LEKCIJA-2");
    expect(builderMessage).not.toContain("LEKCIJA-3");
    expect(builderMessage).not.toContain("<lekcija>");
    const reviewInput = review.mock.calls[0]![0];
    expect(reviewInput.lessonMd).toBe("");
    expect(reviewInput.earlierLessons.map((l) => l.classNumber)).toEqual([1, 2]);

    const [released] = db().select().from(quiz).all();
    expect(released).toMatchObject({ courseId, classId: null, code: "K1" });
    const [job] = kJobs();
    expect(job).toMatchObject({
      status: "succeeded",
      quizCode: "K1",
      classId: classIds[1],
      cycle: 1,
    });
    expect(released!.jobId).toBe(job!.id);
    expect(db().select().from(quizPlan).get()).toMatchObject({
      jobId: job!.id,
      classId: classIds[1],
      quizId: released!.id,
    });
    const releasedEvent = events.find((e) => e.type === DOMAIN_EVENTS.QUIZ_RELEASED)!;
    expect(releasedEvent.payload as QuizReleasedPayload).toEqual({
      classId: classIds[1],
      quizId: released!.id,
      code: "K1",
    });
    const jobUpdates = events
      .filter((e) => e.type === DOMAIN_EVENTS.JOB_UPDATED)
      .map((e) => (e.payload as Extract<PipelineEvent, { type: "job" }>).job);
    expect(jobUpdates.every((j) => j.quizCode === "K1" && j.classId === classIds[1])).toBe(true);
    expect(jobUpdates.map((j) => [j.status, j.stage])).toEqual([
      ["running", "quiz-planner"],
      ["running", "quiz-builder"],
      ["running", "quiz-reviewer"],
      ["succeeded", "quiz-reviewer"],
    ]);

    const after = await status();
    expect(after.due).toBeNull();
    expect(after.existing).toEqual([{ code: "K1", quizId: released!.id, coversThrough: 2 }]);
    expect((await progress()).flags.cumulativeDue).toBeNull();
  });

  it("runs the fix loop like a lesson quiz and fails after 3 fix cycles, then rebuilds from scratch", async () => {
    addClasses(2);
    review.mockResolvedValue(REJECTED);
    expect((await post()).statusCode).toBe(202);
    await waitFor(() => finished(1));
    const [failed] = kJobs();
    expect(failed).toMatchObject({ status: "failed", cycle: 4 });
    expect(failed!.error).toContain("did not pass after 3 fix cycles");
    expect(send).toHaveBeenCalledTimes(4); // the build plus three fix rounds
    expect(db().select().from(quiz).all()).toEqual([]);
    // the failed review is due again, and a new request retries it from scratch
    expect((await status()).due?.code).toBe("K1");
    expect((await progress()).cumulative).toEqual([
      expect.objectContaining({ code: "K1", status: "due", quizId: null }),
    ]);

    review.mockResolvedValue(APPROVED);
    const retry = await post({ code: "K1" });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ attempt: 2 });
    await waitFor(() => finished(2));
    expect(kJobs().map((j) => [j.attempt, j.status, j.parentJobId])).toEqual([
      [1, "failed", null],
      [2, "succeeded", failed!.id],
    ]);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(db().select().from(quiz).all()).toHaveLength(1);
  });

  it("marks the job failed when the planner fails and does not touch the lesson quiz of the class", async () => {
    addClasses(2);
    plan.mockRejectedValueOnce(new StageError("failed", "api down"));
    await post();
    await waitFor(() => finished(1));
    expect(kJobs()[0]).toMatchObject({ status: "failed" });
    expect(kJobs()[0]!.error).toContain("Quiz planner failed");
    // regenerating the class's own quiz is not confused by the failed K job on that class
    const lessonQuiz = await t.app.inject({
      method: "POST",
      url: `/api/classes/${classIds[1]}/quiz/regenerate`,
    });
    expect(lessonQuiz.statusCode).toBe(202);
    expect(lessonQuiz.json()).toMatchObject({ quizCode: null, attempt: 1 });
  });

  it("rejects a duplicate code, a running review, an unknown course and a bad body", async () => {
    addClasses(2);
    let release!: () => void;
    plan.mockImplementationOnce(
      (ctx) =>
        new Promise((resolve) => {
          release = () => resolve({ ...cumulativePlanFixture(), code: ctx.code });
        }),
    );
    expect((await post()).statusCode).toBe(202);
    // running now
    const running = await post({ code: "K1" });
    expect(running.statusCode).toBe(409);
    expect(running.json().error.message).toContain("already generating");
    expect((await post()).statusCode).toBe(409);
    expect((await progress()).cumulative).toEqual([
      expect.objectContaining({ code: "K1", status: "building", coversThrough: 2 }),
    ]);
    release();
    await waitFor(() => finished(1));

    // released: a duplicate
    const dup = await post({ code: "K1" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toContain("already exists");
    expect(kJobs()).toHaveLength(1);

    expect((await post({}, 999)).statusCode).toBe(404);
    expect((await post({ code: "P01" })).statusCode).toBe(400);
    expect((await post({ code: 1 })).statusCode).toBe(400);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/courses/999/cumulative" })).statusCode,
    ).toBe(404);
  });

  it("rejects a course with no ready lesson", async () => {
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(await status()).toEqual({ cadence: 2, readyClassCount: 0, due: null, existing: [] });
  });

  it("builds a manual review over all ready classes for a course without cadence", async () => {
    db().update(course).set({ reviewCadence: null }).where(eq(course.id, courseId)).run();
    addClasses(3);
    expect((await status()).due).toBeNull();
    expect((await progress()).flags.cumulativeDue).toBeNull();

    const response = await post();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ quizCode: "K1", classId: classIds[2] });
    await waitFor(() => finished(1));
    expect(plan.mock.calls[0]![0].coveredClasses.map((c) => c.classNumber)).toEqual([1, 2, 3]);
    expect(db().select().from(quiz).get()).toMatchObject({ code: "K1", classId: null });

    // the next manual review is K2
    expect((await post()).json()).toMatchObject({ quizCode: "K2" });
    await waitFor(() => finished(2));
    expect(
      db()
        .select()
        .from(quiz)
        .all()
        .map((q) => q.code),
    ).toEqual(["K1", "K2"]);
  });

  it("builds a manual review for a non-due code with a cadence (covering all ready classes)", async () => {
    addClasses(3);
    const response = await post({ code: "K4" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ quizCode: "K4", classId: classIds[2] });
    await waitFor(() => finished(1));
    expect(db().select().from(quiz).get()).toMatchObject({ code: "K4", classId: null });
    // the due K1 is still due
    expect((await status()).due?.code).toBe("K1");
  });

  it("shows the schedule: due, building, available, submitted, graded", async () => {
    addClasses(4);
    const cumulative = async () => (await progress()).cumulative;
    expect(await cumulative()).toEqual([
      {
        code: "K1",
        coversThrough: 2,
        status: "due",
        quizId: null,
        submittedAt: null,
        totalScore: null,
      },
    ]);

    await post();
    await waitFor(() => finished(1));
    const [released] = db().select().from(quiz).all();
    expect(await cumulative()).toEqual([
      {
        code: "K1",
        coversThrough: 2,
        status: "available",
        quizId: released!.id,
        submittedAt: null,
        totalScore: null,
      },
      expect.objectContaining({ code: "K2", coversThrough: 4, status: "due" }),
    ]);
    expect((await progress()).flags.cumulativeDue).toEqual({ code: "K2", coversThrough: 4 });

    const sub = db()
      .insert(submission)
      .values({
        quizId: released!.id,
        answersJson: {},
        autoScore: 3,
        autoMax: 6,
        dontKnowJson: [],
        resultsJson: [],
        openPending: 2,
      })
      .returning()
      .get();
    expect((await cumulative())[0]).toMatchObject({
      status: "submitted",
      submittedAt: sub.submittedAt.toISOString(),
      totalScore: null,
    });

    db()
      .insert(result)
      .values({
        submissionId: sub.id,
        resultJson: gradingResultFixture(),
        openScore: 1.5,
        totalScore: 4.5,
        writeupMd: "x",
      })
      .run();
    expect((await cumulative())[0]).toMatchObject({ status: "graded", totalScore: 4.5 });
  });

  it("leaves out backlog items of classes the review does not cover", async () => {
    addClasses(3);
    const topicOfClass3 = db()
      .select()
      .from(topic)
      .where(and(eq(topic.classId, classIds[2]!)))
      .get()!;
    db()
      .insert(backlogItem)
      .values({ courseId, topicId: topicOfClass3.id, dueQuiz: "K1", reason: "weak" })
      .run();
    await post();
    await waitFor(() => finished(1));
    expect(plan.mock.calls[0]![0].backlog).toEqual([]);
  });
});
