import { and, desc, eq } from "drizzle-orm";
import { validateQuiz, type GenerationJob, type QuizDraft } from "@studdy/shared";
import type { Coordinator, CoordinatorLogger } from "../agents/coordinator.js";
import {
  buildQuizBuilderMessage,
  buildQuizFixMessage,
  openQuizBuilderSession as realOpenQuizBuilderSession,
} from "../agents/quiz-builder.js";
import { planQuiz as realPlanQuiz } from "../agents/quiz-planner.js";
import { reviewQuiz as realReviewQuiz } from "../agents/quiz-reviewer.js";
import { StageError, type StageSession } from "../agents/stage.js";
import type { Db } from "../db/client.js";
import {
  classTable,
  generationJob,
  quiz as quizTable,
  quizPlan,
  type QuizPlanLogEntry,
} from "../db/schema.js";
import { loadQuizContext, notesMisconceptions } from "../quiz/context.js";
import { ConflictError } from "../repositories/conflict.js";
import { getJob } from "../repositories/lessons.js";
import { notFound } from "../routes/errors.js";
import { createJobEmitter, createProgressReporter, truncate } from "./common.js";
import {
  DOMAIN_EVENTS,
  type LessonReadyPayload,
  type QuizReleasedPayload,
  type QuizRequestedPayload,
} from "./events.js";

/** The agent calls of the quiz branch; replaceable in tests. */
export interface QuizAgents {
  planQuiz: typeof realPlanQuiz;
  openQuizBuilderSession: typeof realOpenQuizBuilderSession;
  reviewQuiz: typeof realReviewQuiz;
}

export interface QuizBranchOptions {
  db: Db;
  coordinator: Coordinator;
  logger: CoordinatorLogger;
  agents?: Partial<QuizAgents>;
  /** Minimum gap between two progress events of a job. */
  progressIntervalMs?: number;
  /** Start a quiz job on every `lesson.ready` (default). Off: only `requestRegeneration` starts one. */
  autoStart?: boolean;
}

export interface QuizBranch {
  /**
   * Starts (or re-plans and rebuilds) the quiz of a `ready` class that has no released quiz and
   * whose latest quiz job failed or does not exist (classes generated before the quiz branch).
   * Throws 404/409 `ApiError`s.
   */
  requestRegeneration(classId: number): GenerationJob;
}

export const QUIZ_STAGES = {
  planner: "quiz-planner",
  builder: "quiz-builder",
  reviewer: "quiz-reviewer",
} as const;

/** Fix rounds the builder gets after a review before the job fails. */
export const MAX_FIX_CYCLES = 3;

const SUMMARY_LENGTH = 300;

class QuizReviewFailedError extends Error {
  constructor(summary: string) {
    super(
      `Quiz review did not pass after ${MAX_FIX_CYCLES} fix cycles: ${truncate(summary, SUMMARY_LENGTH)}`,
    );
    this.name = "QuizReviewFailedError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function registerQuizBranch({
  db,
  coordinator,
  logger,
  agents,
  progressIntervalMs = 500,
  autoStart = true,
}: QuizBranchOptions): QuizBranch {
  const { planQuiz, openQuizBuilderSession, reviewQuiz }: QuizAgents = {
    planQuiz: realPlanQuiz,
    openQuizBuilderSession: realOpenQuizBuilderSession,
    reviewQuiz: realReviewQuiz,
    ...agents,
  };
  const emitJob = createJobEmitter(db, coordinator);
  const progressFor = createProgressReporter(coordinator, progressIntervalMs);

  function describeError(stage: string, error: unknown): string {
    if (error instanceof QuizReviewFailedError) return truncate(error.message);
    const name = stage.replace(/^quiz-/, "");
    const message =
      error instanceof StageError
        ? `Quiz ${name} failed (${error.kind}): ${error.message}`
        : `Quiz ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    return truncate(message);
  }

  /** Inserts a running quiz job for the class and returns its id. Call inside a transaction. */
  function insertQuizJob(tx: Tx, classId: number, parentJobId: number | null): number {
    const previous = tx
      .select({ attempt: generationJob.attempt })
      .from(generationJob)
      .where(and(eq(generationJob.classId, classId), eq(generationJob.kind, "quiz")))
      .orderBy(desc(generationJob.id))
      .limit(1)
      .get();
    return tx
      .insert(generationJob)
      .values({
        classId,
        kind: "quiz",
        stage: QUIZ_STAGES.planner,
        status: "running",
        attempt: (previous?.attempt ?? 0) + 1,
        parentJobId,
      })
      .returning({ id: generationJob.id })
      .get().id;
  }

  function latestLessonJobId(tx: Tx, classId: number): number | null {
    return (
      tx
        .select({ id: generationJob.id })
        .from(generationJob)
        .where(and(eq(generationJob.classId, classId), eq(generationJob.kind, "lesson")))
        .orderBy(desc(generationJob.id))
        .limit(1)
        .get()?.id ?? null
    );
  }

  function requestRegeneration(classId: number): GenerationJob {
    const jobId = db.transaction((tx) => {
      const cls = tx.select().from(classTable).where(eq(classTable.id, classId)).get();
      if (!cls) throw notFound("Class");
      if (cls.status !== "ready") throw new ConflictError("The class has no finished lesson");
      const last = tx
        .select()
        .from(generationJob)
        .where(and(eq(generationJob.classId, classId), eq(generationJob.kind, "quiz")))
        .orderBy(desc(generationJob.id))
        .limit(1)
        .get();
      if (last?.status === "running") throw new ConflictError("The quiz is already generating");
      if (last && last.status !== "failed") {
        throw new ConflictError("The quiz was already generated");
      }
      const released = tx
        .select({ id: quizTable.id })
        .from(quizTable)
        .where(eq(quizTable.classId, classId))
        .limit(1)
        .get();
      if (released) throw new ConflictError("The class already has a released quiz");
      return insertQuizJob(tx, classId, last?.id ?? latestLessonJobId(tx, classId));
    });
    emitJob(jobId);
    const payload: QuizRequestedPayload = { classId, jobId };
    coordinator.emit(DOMAIN_EVENTS.QUIZ_REQUESTED, payload);
    return getJob(db, jobId)!;
  }

  /** `lesson.ready`: opens the quiz job of the freshly generated class. */
  function startQuizJob({ classId }: LessonReadyPayload): void {
    const jobId = db.transaction((tx) =>
      insertQuizJob(tx, classId, latestLessonJobId(tx, classId)),
    );
    emitJob(jobId);
    const payload: QuizRequestedPayload = { classId, jobId };
    coordinator.emit(DOMAIN_EVENTS.QUIZ_REQUESTED, payload);
  }

  function setStage(jobId: number, stage: string, cycle: number | null): void {
    db.update(generationJob).set({ stage, cycle }).where(eq(generationJob.id, jobId)).run();
    emitJob(jobId);
  }

  function courseOf(classId: number): number {
    const row = db
      .select({ courseId: classTable.courseId })
      .from(classTable)
      .where(eq(classTable.id, classId))
      .get();
    if (!row) throw new Error("The class no longer exists");
    return row.courseId;
  }

  function courseCodes(courseId: number): string[] {
    return db
      .select({ code: quizTable.code })
      .from(quizTable)
      .where(eq(quizTable.courseId, courseId))
      .all()
      .map((r) => r.code);
  }

  function duplicateCodeError(code: string): Error {
    return new Error(`A quiz with the code ${code} already exists in this course`);
  }

  /** One transaction: the quiz, the plan's link to it, the job succeeded. */
  function release(jobId: number, classId: number, planId: number, draft: QuizDraft, code: string) {
    return db.transaction((tx) => {
      const courseId = courseOf(classId);
      const existing = tx
        .select({ id: quizTable.id })
        .from(quizTable)
        .where(and(eq(quizTable.courseId, courseId), eq(quizTable.code, code)))
        .get();
      if (existing) throw duplicateCodeError(code);
      const quizId = tx
        .insert(quizTable)
        .values({
          courseId,
          classId,
          code,
          title: draft.quiz.title,
          subtitle: draft.quiz.subtitle,
          chipsJson: draft.quiz.chips,
          questionsJson: draft.quiz.questions,
          jobId,
        })
        .returning({ id: quizTable.id })
        .get().id;
      tx.update(quizPlan).set({ quizId }).where(eq(quizPlan.id, planId)).run();
      tx.update(generationJob)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      return quizId;
    });
  }

  function markFailed(jobId: number, stage: string, error: unknown): void {
    try {
      db.update(generationJob)
        .set({ status: "failed", error: describeError(stage, error), finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      emitJob(jobId);
    } catch (persistError) {
      logger.error({ err: persistError, jobId }, "could not mark the quiz job as failed");
    }
  }

  async function runQuizJob({ classId, jobId }: QuizRequestedPayload): Promise<void> {
    let stage: string = QUIZ_STAGES.planner;
    let session: StageSession<QuizDraft> | undefined;
    let released: { quizId: number; code: string };
    try {
      const ctx = loadQuizContext(db, classId);
      const courseId = courseOf(classId);

      const plan = await planQuiz(ctx, {
        onEvent: progressFor({ classId, jobId, stage: QUIZ_STAGES.planner }),
      });
      // Fail before spending the builder and reviewer on a quiz that cannot be released.
      if (courseCodes(courseId).includes(plan.code)) throw duplicateCodeError(plan.code);

      const log: QuizPlanLogEntry[] = [];
      const planId = db
        .insert(quizPlan)
        .values({ jobId, classId, planJson: plan, logJson: log })
        .returning({ id: quizPlan.id })
        .get().id;
      const saveProgress = (draft: QuizDraft | undefined): void => {
        db.update(quizPlan)
          .set({ logJson: log, ...(draft && { draftJson: draft }) })
          .where(eq(quizPlan.id, planId))
          .run();
      };

      stage = QUIZ_STAGES.builder;
      setStage(jobId, stage, null);
      session = openQuizBuilderSession(plan, {
        onEvent: progressFor({ classId, jobId, stage: QUIZ_STAGES.builder }),
      });
      let draft = await session.send(
        buildQuizBuilderMessage({
          plan,
          lessonMd: ctx.lessonMd,
          notesMisconceptions: notesMisconceptions(ctx),
        }),
      );
      saveProgress(draft);

      for (let cycle = 1; ; cycle++) {
        stage = QUIZ_STAGES.reviewer;
        setStage(jobId, stage, cycle);
        const report = validateQuiz(draft.quiz, { existingCodes: courseCodes(courseId) });
        const entry: QuizPlanLogEntry = { cycle, report, review: null, flags: draft.flags };
        log.push(entry);
        saveProgress(undefined);
        const review = await reviewQuiz(
          { plan, quiz: draft.quiz, flags: draft.flags, lessonMd: ctx.lessonMd, report },
          { onEvent: progressFor({ classId, jobId, stage: QUIZ_STAGES.reviewer }) },
        );
        entry.review = review;
        saveProgress(undefined);
        if (review.approved) break;
        if (cycle > MAX_FIX_CYCLES) throw new QuizReviewFailedError(review.summary);

        stage = QUIZ_STAGES.builder;
        setStage(jobId, stage, cycle);
        draft = await session.send(buildQuizFixMessage(review.fixes, report));
        saveProgress(draft);
      }

      released = { quizId: release(jobId, classId, planId, draft, plan.code), code: plan.code };
    } catch (error) {
      logger.error({ err: error, jobId, classId, stage }, "quiz generation failed");
      markFailed(jobId, stage, error);
      return;
    } finally {
      session?.close();
    }
    // Outside the try: a failure to notify must not turn a released quiz into a failed job.
    emitJob(jobId);
    const payload: QuizReleasedPayload = { classId, ...released };
    coordinator.emit(DOMAIN_EVENTS.QUIZ_RELEASED, payload);
  }

  coordinator.on<QuizRequestedPayload>(DOMAIN_EVENTS.QUIZ_REQUESTED, runQuizJob);
  if (autoStart) coordinator.on<LessonReadyPayload>(DOMAIN_EVENTS.LESSON_READY, startQuizJob);

  return { requestRegeneration };
}
