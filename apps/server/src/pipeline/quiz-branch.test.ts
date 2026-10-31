import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { eq } from "drizzle-orm";
import type { PipelineEvent, QuizDraft, QuizReview } from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentRuntime } from "../agents/runtime.js";
import { StageError, type StageSession } from "../agents/stage.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { planFixture, quizFixture } from "../agents/testing/quiz-fixtures.js";
import { classTable, course, generationJob, lesson, quiz, quizPlan } from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { DOMAIN_EVENTS, type QuizReleasedPayload } from "./events.js";
import { RESTART_ERROR } from "./pipeline.js";
import type { QuizAgents } from "./quiz-branch.js";

const DRAFT: QuizDraft = {
  quiz: quizFixture(),
  flags: [{ questionId: "q2", issue: "Plan deluje sumnjivo." }],
};
const FIXED: QuizDraft = {
  quiz: { ...quizFixture(), subtitle: "Predavanje 2 (ispravljeno)" },
  flags: [],
};
const APPROVED: QuizReview = { approved: true, summary: "Sve je u redu.", fixes: [] };
const REJECTED: QuizReview = {
  approved: false,
  summary: "Jedno pitanje ima dva tačna odgovora.",
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
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-quiz-branch-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("quiz branch", () => {
  let t: TestApp;
  let courseId: number;
  let classId: number;
  let events: SemanticEvent[];
  let plan: ReturnType<typeof vi.fn<QuizAgents["planQuiz"]>>;
  let review: ReturnType<typeof vi.fn<QuizAgents["reviewQuiz"]>>;
  let send: ReturnType<typeof vi.fn<(message: string) => Promise<QuizDraft>>>;
  let close: ReturnType<typeof vi.fn<() => void>>;
  let open: ReturnType<typeof vi.fn<QuizAgents["openQuizBuilderSession"]>>;

  const db = () => t.handle.db;
  const quizJobs = () =>
    db().select().from(generationJob).where(eq(generationJob.kind, "quiz")).all();
  const classStatus = () =>
    db().select().from(classTable).where(eq(classTable.id, classId)).get()!.status;
  const quizzes = () => db().select().from(quiz).all();
  const types = () => events.map((e) => e.type);
  const quizJobUpdates = () =>
    events
      .filter((e) => e.type === DOMAIN_EVENTS.JOB_UPDATED)
      .map((e) => (e.payload as Extract<PipelineEvent, { type: "job" }>).job)
      .filter((j) => j.kind === "quiz");
  const finished = (n = 1) =>
    quizJobs().length >= n && quizJobs().every((j) => j.status !== "running");

  function startBranch(): void {
    t.coordinator!.emit(DOMAIN_EVENTS.LESSON_READY, { classId, lessonId: 1 });
  }

  /** Fails the first quiz job (planner error) so that a regeneration may be requested. */
  async function failFirstJob(): Promise<void> {
    plan.mockRejectedValueOnce(new StageError("failed", "api down"));
    startBranch();
    await waitFor(() => finished(1));
  }

  beforeEach(() => {
    plan = vi.fn<QuizAgents["planQuiz"]>(async () => planFixture());
    review = vi.fn<QuizAgents["reviewQuiz"]>(async () => APPROVED);
    send = vi.fn(async () => DRAFT);
    close = vi.fn();
    open = vi.fn<QuizAgents["openQuizBuilderSession"]>(
      () => ({ send, close }) as unknown as StageSession<QuizDraft>,
    );
    t = createTestApp({
      pipeline: {
        writeLesson: async () => {
          throw new Error("not used");
        },
        quizAgents: { planQuiz: plan, openQuizBuilderSession: open, reviewQuiz: review },
        vizAutoStart: false,
      },
    });
    events = [];
    t.coordinator!.subscribe((e) => events.push(e));

    courseId = db().insert(course).values({ name: "Kurs" }).returning({ id: course.id }).get().id;
    classId = db()
      .insert(classTable)
      .values({ courseId, number: 2, title: "Obrada podataka", status: "ready" })
      .returning({ id: classTable.id })
      .get().id;
    db().insert(lesson).values({ classId, bodyMd: "Lekcija." }).run();
    db()
      .insert(generationJob)
      .values({
        classId,
        kind: "lesson",
        stage: "lesson-writer",
        status: "succeeded",
        attempt: 1,
        finishedAt: new Date(),
      })
      .run();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("releases an approved quiz and stores the plan with its review log", async () => {
    startBranch();
    await waitFor(() => types().includes(DOMAIN_EVENTS.QUIZ_RELEASED));

    const [job] = quizJobs();
    const lessonJob = db()
      .select()
      .from(generationJob)
      .where(eq(generationJob.kind, "lesson"))
      .get()!;
    expect(job).toMatchObject({
      kind: "quiz",
      status: "succeeded",
      attempt: 1,
      error: null,
      cycle: 1,
      parentJobId: lessonJob.id,
    });
    expect(job!.finishedAt).not.toBeNull();
    expect(classStatus()).toBe("ready");

    const [released] = quizzes();
    expect(released).toMatchObject({
      courseId,
      classId,
      code: "P02",
      title: "Obrada podataka",
      subtitle: "Predavanje 2",
      jobId: job!.id,
    });
    expect(released!.chipsJson).toEqual(DRAFT.quiz.chips);
    expect(released!.questionsJson).toEqual(DRAFT.quiz.questions);
    expect(events.at(-1)!.payload as QuizReleasedPayload).toEqual({
      classId,
      quizId: released!.id,
      code: "P02",
    });

    const [stored] = db().select().from(quizPlan).all();
    expect(stored).toMatchObject({ jobId: job!.id, classId, quizId: released!.id });
    expect(stored!.planJson).toEqual(planFixture());
    expect(stored!.draftJson).toEqual(DRAFT);
    expect(stored!.logJson).toHaveLength(1);
    expect(stored!.logJson[0]).toMatchObject({
      cycle: 1,
      review: APPROVED,
      flags: DRAFT.flags,
      report: { errors: [], warnings: [] },
    });

    // planner -> builder -> reviewer (cycle 1) -> succeeded, in that order
    expect(quizJobUpdates().map((j) => [j.status, j.stage, j.cycle])).toEqual([
      ["running", "quiz-planner", null],
      ["running", "quiz-builder", null],
      ["running", "quiz-reviewer", 1],
      ["succeeded", "quiz-reviewer", 1],
    ]);
    const releasedIndex = types().indexOf(DOMAIN_EVENTS.QUIZ_RELEASED);
    expect(types()[releasedIndex - 1]).toBe(DOMAIN_EVENTS.JOB_UPDATED);
    expect(close).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("starts the quiz job after the lesson is ready", async () => {
    // the lesson-ready handler is what creates the job
    expect(quizJobs()).toHaveLength(0);
    startBranch();
    await waitFor(() => quizJobs().length === 1);
    await waitFor(() => finished());
  });

  it("sends fixes to the same builder session until the review passes", async () => {
    review.mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(REJECTED);
    send.mockResolvedValueOnce(DRAFT).mockResolvedValueOnce(FIXED).mockResolvedValueOnce(FIXED);

    startBranch();
    await waitFor(() => types().includes(DOMAIN_EVENTS.QUIZ_RELEASED));

    expect(open).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(3); // the build plus 2 fix rounds
    expect(send.mock.calls[1]![0]).toContain("Dve opcije su tačne.");
    expect(review.mock.calls[2]![0].quiz).toEqual(FIXED.quiz);
    expect(quizzes()[0]!.subtitle).toBe("Predavanje 2 (ispravljeno)");
    expect(close).toHaveBeenCalledTimes(1);
    expect(quizJobUpdates().map((j) => [j.stage, j.cycle])).toEqual([
      ["quiz-planner", null],
      ["quiz-builder", null],
      ["quiz-reviewer", 1],
      ["quiz-builder", 1],
      ["quiz-reviewer", 2],
      ["quiz-builder", 2],
      ["quiz-reviewer", 3],
      ["quiz-reviewer", 3],
    ]);
    const [stored] = db().select().from(quizPlan).all();
    expect(stored!.logJson.map((e) => [e.cycle, e.review?.approved])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(stored!.draftJson).toEqual(FIXED);
  });

  it("fails after 4 reviews and 3 fix rounds, leaving no quiz", async () => {
    review.mockResolvedValue(REJECTED);

    startBranch();
    await waitFor(() => finished());

    expect(review).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledTimes(4); // the build plus 3 fix rounds
    expect(close).toHaveBeenCalledTimes(1);
    const [job] = quizJobs();
    expect(job).toMatchObject({ status: "failed" });
    expect(job!.error).toBe(
      "Quiz review did not pass after 3 fix cycles: Jedno pitanje ima dva tačna odgovora.",
    );
    expect(job!.finishedAt).not.toBeNull();
    expect(quizzes()).toHaveLength(0);
    expect(types()).not.toContain(DOMAIN_EVENTS.QUIZ_RELEASED);
    expect(classStatus()).toBe("ready");
    const [stored] = db().select().from(quizPlan).all();
    expect(stored).toMatchObject({ quizId: null });
    expect(stored!.logJson).toHaveLength(4);
    expect(quizJobUpdates().at(-1)).toMatchObject({ status: "failed", cycle: 4 });
  });

  it("truncates a long reviewer summary in the error", async () => {
    review.mockResolvedValue({ ...REJECTED, summary: "x".repeat(2000) });
    startBranch();
    await waitFor(() => finished());
    const error = quizJobs()[0]!.error!;
    expect(error.length).toBeLessThan(400);
    expect(error).toMatch(/^Quiz review did not pass after 3 fix cycles: x+\.\.\.$/);
  });

  it("fails the job, not the class, when the planner fails", async () => {
    plan.mockRejectedValueOnce(new StageError("schema", "answer does not match"));
    startBranch();
    await waitFor(() => finished());

    expect(quizJobs()[0]).toMatchObject({
      status: "failed",
      error: "Quiz planner failed (schema): answer does not match",
    });
    expect(classStatus()).toBe("ready");
    expect(open).not.toHaveBeenCalled();
    expect(db().select().from(quizPlan).all()).toHaveLength(0);
    expect(quizJobUpdates().at(-1)).toMatchObject({ status: "failed" });
    expect(events.at(-1)!.payload).toMatchObject({ type: "job", classStatus: "ready" });
  });

  it("fails the job and closes the session when the builder or reviewer fails", async () => {
    send.mockRejectedValueOnce(new StageError("timeout", "no answer"));
    startBranch();
    await waitFor(() => finished(1));
    expect(quizJobs()[0]!.error).toBe("Quiz builder failed (timeout): no answer");
    expect(close).toHaveBeenCalledTimes(1);

    review.mockRejectedValueOnce(new Error("boom"));
    startBranch();
    await waitFor(() => finished(2));
    expect(quizJobs()[1]!.error).toBe("Quiz reviewer failed: boom");
    expect(quizJobs()[1]!.attempt).toBe(2);
    expect(close).toHaveBeenCalledTimes(2);
    const stored = db().select().from(quizPlan).all();
    expect(stored[1]!.logJson).toEqual([
      expect.objectContaining({ cycle: 1, review: null, flags: DRAFT.flags }),
    ]);
    expect(classStatus()).toBe("ready");
  });

  it("never overwrites a quiz whose code is already taken in the course", async () => {
    const existing = db()
      .insert(quiz)
      .values({
        courseId,
        classId: null,
        code: "P02",
        title: "Staro",
        subtitle: "Staro",
        chipsJson: [],
        questionsJson: [],
      })
      .returning({ id: quiz.id })
      .get().id;

    startBranch();
    await waitFor(() => finished());

    expect(quizJobs()[0]).toMatchObject({
      status: "failed",
      error: "Quiz planner failed: A quiz with the code P02 already exists in this course",
    });
    expect(quizzes()).toHaveLength(1);
    expect(quizzes()[0]).toMatchObject({ id: existing, title: "Staro" });
    expect(types()).not.toContain(DOMAIN_EVENTS.QUIZ_RELEASED);
    expect(classStatus()).toBe("ready");
  });

  it("fails at release when the code was taken while the quiz was being built", async () => {
    review.mockImplementationOnce(async () => {
      db()
        .insert(quiz)
        .values({
          courseId,
          classId: null,
          code: "P02",
          title: "Zauzeto",
          subtitle: "Zauzeto",
          chipsJson: [],
          questionsJson: [],
        })
        .run();
      return APPROVED;
    });
    startBranch();
    await waitFor(() => finished());
    expect(quizJobs()[0]).toMatchObject({ status: "failed" });
    expect(quizJobs()[0]!.error).toMatch(/already exists in this course/);
    expect(quizzes()).toHaveLength(1);
    expect(quizzes()[0]!.title).toBe("Zauzeto");
    expect(db().select().from(quizPlan).get()!.quizId).toBeNull();
  });

  describe("regeneration", () => {
    it("is refused unless the last quiz job failed or is absent", async () => {
      expect(() => t.pipeline!.requestQuizRegeneration(9999)).toThrow(/Class not found/);

      startBranch();
      await waitFor(() => finished());
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/already generated/);

      db().update(classTable).set({ status: "failed" }).where(eq(classTable.id, classId)).run();
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/no finished lesson/);
      expect(quizJobs()).toHaveLength(1);
    });

    it("starts the first quiz of a ready class that never had a quiz job", async () => {
      expect(quizJobs()).toHaveLength(0);
      const started = t.pipeline!.requestQuizRegeneration(classId);
      expect(started).toMatchObject({
        kind: "quiz",
        status: "running",
        attempt: 1,
        stage: "quiz-planner",
        cycle: null,
      });
      const lessonJob = db()
        .select()
        .from(generationJob)
        .where(eq(generationJob.kind, "lesson"))
        .get()!;
      expect(quizJobs()[0]!.parentJobId).toBe(lessonJob.id);
      await waitFor(() => types().includes(DOMAIN_EVENTS.QUIZ_RELEASED));
      expect(quizzes()).toHaveLength(1);
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/already generated/);
    });

    it("is refused when a quiz was released although no quiz job exists", () => {
      db()
        .insert(quiz)
        .values({
          courseId,
          classId,
          code: "P98",
          title: "T",
          subtitle: "S",
          chipsJson: [],
          questionsJson: [],
        })
        .run();
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/already has a released/);
    });

    it("is refused while the quiz job is running", async () => {
      let release!: (p: ReturnType<typeof planFixture>) => void;
      plan.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
      startBranch();
      await waitFor(() => quizJobs().length === 1);
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/already generating/);
      release(planFixture());
      await waitFor(() => finished());
    });

    it("is refused when a quiz was released for the class", async () => {
      await failFirstJob();
      db()
        .insert(quiz)
        .values({
          courseId,
          classId,
          code: "P99",
          title: "T",
          subtitle: "S",
          chipsJson: [],
          questionsJson: [],
        })
        .run();
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/already has a released/);
    });

    it("re-plans and rebuilds from scratch as attempt 2 after a failure", async () => {
      review.mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(REJECTED);
      review.mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(REJECTED);
      startBranch();
      await waitFor(() => finished(1));
      expect(quizJobs()[0]!.status).toBe("failed");
      expect(plan).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);

      const second = t.pipeline!.requestQuizRegeneration(classId);
      expect(second).toMatchObject({
        kind: "quiz",
        status: "running",
        attempt: 2,
        stage: "quiz-planner",
        cycle: null,
      });
      expect(quizJobs()[1]!.parentJobId).toBe(quizJobs()[0]!.id);
      await waitFor(() => types().includes(DOMAIN_EVENTS.QUIZ_RELEASED));

      expect(plan).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(2);
      expect(quizzes()).toHaveLength(1);
      expect(quizJobs()[1]).toMatchObject({ status: "succeeded", attempt: 2 });
      expect(db().select().from(quizPlan).all()).toHaveLength(2);
      expect(db().select().from(quizPlan).all()[1]!.quizId).toBe(quizzes()[0]!.id);
      // a released quiz ends the offer
      expect(() => t.pipeline!.requestQuizRegeneration(classId)).toThrow(/already generated/);
    });
  });

  it("recovery marks running quiz jobs failed without touching a ready class", async () => {
    const stuck = db()
      .insert(generationJob)
      .values({ classId, kind: "quiz", stage: "quiz-builder", status: "running", attempt: 1 })
      .returning({ id: generationJob.id })
      .get().id;

    t.pipeline!.recoverInterruptedJobs();

    expect(quizJobs().find((j) => j.id === stuck)).toMatchObject({
      status: "failed",
      error: RESTART_ERROR,
    });
    expect(classStatus()).toBe("ready");
    // and the failed quiz can be regenerated
    expect(t.pipeline!.requestQuizRegeneration(classId)).toMatchObject({ attempt: 2 });
    await waitFor(() => finished(2));
  });

  it("emits throttled progress events for the quiz stages", async () => {
    const delta = (text: string) =>
      ({
        type: "inference.stream",
        payload: { type: "content_block_delta", delta: { type: "text_delta", text } },
      }) as unknown as SemanticEvent;
    plan.mockImplementationOnce(async (_ctx, opts) => {
      opts?.onEvent?.(delta("abc"));
      return planFixture();
    });
    startBranch();
    await waitFor(() => finished());
    const progress = events
      .filter((e) => e.type === DOMAIN_EVENTS.JOB_PROGRESS)
      .map((e) => e.payload);
    expect(progress).toEqual([
      expect.objectContaining({ stage: "quiz-planner", outputChars: 3, classId }),
    ]);
  });
});
