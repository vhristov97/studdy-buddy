import { and, eq, isNull } from "drizzle-orm";
import type { GenerationJob, GradingResult } from "@studdy/shared";
import type { Coordinator, CoordinatorLogger } from "../agents/coordinator.js";
import { gradeSubmission as realGradeSubmission } from "../agents/grader.js";
import { StageError } from "../agents/stage.js";
import type { Db } from "../db/client.js";
import {
  backlogItem,
  classTable,
  generationJob,
  learnerObservation,
  nextStep,
  quiz as quizTable,
  result as resultTable,
  submission,
  topic,
  topicEvent,
} from "../db/schema.js";
import { loadGradingContext, type GradingContext } from "../grading/context.js";
import { checkGradingInvariants } from "../grading/invariants.js";
import { ConflictError } from "../repositories/conflict.js";
import { latestGradingJob } from "../repositories/grading.js";
import { getJob } from "../repositories/lessons.js";
import { notFound } from "../routes/errors.js";
import { createJobEmitter, createProgressReporter, truncate } from "./common.js";
import {
  DOMAIN_EVENTS,
  type GradingDonePayload,
  type GradingRequestedPayload,
  type SubmissionCreatedPayload,
} from "./events.js";

export const GRADING_STAGE = "grader";

export interface GradingBranchOptions {
  db: Db;
  coordinator: Coordinator;
  logger: CoordinatorLogger;
  /** Replaceable in tests. */
  gradeSubmission?: typeof realGradeSubmission;
  /** Minimum gap between two progress events of a job. */
  progressIntervalMs?: number;
  /** Start a grading job on every `submission.created` (default). Off: only `requestRegrade` starts one. */
  autoStart?: boolean;
}

export interface GradingBranch {
  /**
   * Starts grading for a submission that has no result and whose latest grading job failed or does
   * not exist. Throws 404/409 `ApiError`s.
   */
  requestRegrade(submissionId: number): GenerationJob;
}

class GradingInvariantError extends Error {
  constructor(violations: string[]) {
    super(`Grading violated invariant: ${violations.join("; ")}`);
    this.name = "GradingInvariantError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Float noise from summing fractional scores, not rounding of real scores. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

function describeError(error: unknown): string {
  if (error instanceof GradingInvariantError) return truncate(error.message);
  const message =
    error instanceof StageError
      ? `Grading failed (${error.kind}): ${error.message}`
      : `Grading failed: ${error instanceof Error ? error.message : String(error)}`;
  return truncate(message);
}

export function registerGradingBranch({
  db,
  coordinator,
  logger,
  gradeSubmission = realGradeSubmission,
  progressIntervalMs = 500,
  autoStart = true,
}: GradingBranchOptions): GradingBranch {
  const emitJob = createJobEmitter(db, coordinator);
  const progressFor = createProgressReporter(coordinator, progressIntervalMs);

  /** Inserts a running grading job and returns its id. Call inside a transaction. */
  function insertGradingJob(
    tx: Tx,
    classId: number,
    submissionId: number,
    parentJobId: number | null,
  ): number {
    const previous = latestGradingJob(tx, submissionId);
    return tx
      .insert(generationJob)
      .values({
        classId,
        kind: "grading",
        stage: GRADING_STAGE,
        status: "running",
        attempt: (previous?.attempt ?? 0) + 1,
        parentJobId,
        submissionId,
      })
      .returning({ id: generationJob.id })
      .get().id;
  }

  function startJob(jobId: number, classId: number, submissionId: number): void {
    emitJob(jobId);
    const payload: GradingRequestedPayload = { classId, jobId, submissionId };
    coordinator.emit(DOMAIN_EVENTS.GRADING_REQUESTED, payload);
  }

  function requestRegrade(submissionId: number): GenerationJob {
    const { jobId, classId } = db.transaction((tx) => {
      const sub = tx.select().from(submission).where(eq(submission.id, submissionId)).get();
      if (!sub) throw notFound("Submission");
      const owner = tx.select().from(quizTable).where(eq(quizTable.id, sub.quizId)).get();
      if (!owner) throw notFound("Quiz");
      if (tx.select().from(resultTable).where(eq(resultTable.submissionId, sub.id)).get()) {
        throw new ConflictError("The submission is already graded");
      }
      const last = latestGradingJob(tx, sub.id);
      if (last?.status === "running") throw new ConflictError("The submission is being graded");
      if (last && last.status !== "failed") {
        throw new ConflictError("The grading job finished without a result");
      }
      if (owner.classId === null) {
        throw new ConflictError("Quizzes without a class cannot be graded yet");
      }
      return {
        jobId: insertGradingJob(tx, owner.classId, sub.id, last?.id ?? null),
        classId: owner.classId,
      };
    });
    startJob(jobId, classId, submissionId);
    return getJob(db, jobId)!;
  }

  /** `submission.created`: opens the grading job of a fresh submission. */
  function onSubmissionCreated({ quizId, submissionId }: SubmissionCreatedPayload): void {
    const owner = db.select().from(quizTable).where(eq(quizTable.id, quizId)).get();
    if (!owner) return;
    if (owner.classId === null) {
      // Cumulative (K) quizzes belong to no class, which a job needs; grading them comes with M8.
      logger.debug?.({ quizId, submissionId }, "quiz without a class is not graded yet");
      return;
    }
    const classId = owner.classId;
    const jobId = db.transaction((tx) => insertGradingJob(tx, classId, submissionId, null));
    startJob(jobId, classId, submissionId);
  }

  function topicIdOf(tx: Tx, courseId: number, name: string, classNumber: number): number {
    const row = tx
      .select({ id: topic.id })
      .from(topic)
      .innerJoin(classTable, eq(classTable.id, topic.classId))
      .where(
        and(eq(topic.courseId, courseId), eq(topic.name, name), eq(classTable.number, classNumber)),
      )
      .get();
    if (!row) throw new Error(`Topic "${name}" of class ${classNumber} no longer exists`);
    return row.id;
  }

  /** One transaction: everything the grading changes, and the job succeeded. */
  function persist(jobId: number, ctx: GradingContext, graded: GradingResult): number {
    return db.transaction((tx) => {
      const courseId = ctx.course.id;
      const submissionId = ctx.submission.id;
      const code = ctx.quiz.code;
      const grades = new Map(graded.openGrades.map((g) => [g.questionId, g.score]));
      const topicOfQuestion = new Map(ctx.questionTopics.map((t) => [t.questionId, t]));
      const questionTopicId = (questionId: string): number | undefined => {
        const t = topicOfQuestion.get(questionId);
        return t ? topicIdOf(tx, courseId, t.topic, t.classNumber) : undefined;
      };

      const openScore = tidy(graded.openGrades.reduce((sum, g) => sum + g.score, 0));
      const resultId = tx
        .insert(resultTable)
        .values({
          submissionId,
          jobId,
          resultJson: graded,
          openScore,
          totalScore: tidy(ctx.submission.autoScore + openScore),
          writeupMd: graded.writeupMd,
        })
        .returning({ id: resultTable.id })
        .get().id;

      // What happened to each question.
      for (const r of ctx.submission.results) {
        const topicId = questionTopicId(r.id);
        if (topicId === undefined) continue;
        const score = grades.get(r.id);
        tx.insert(topicEvent)
          .values({
            topicId,
            source: "quiz",
            ref: `${code}·${r.id}`,
            outcome:
              r.status === "open_pending" && score !== undefined ? `open:${score}` : r.status,
          })
          .run();
      }

      // What the misses mean.
      for (const item of graded.items) {
        const topicId = questionTopicId(item.questionId);
        if (topicId === undefined) continue;
        tx.insert(topicEvent)
          .values({
            topicId,
            source: "grading",
            ref: `${code}·${item.questionId}${item.rowIndex === null ? "" : `.r${item.rowIndex + 1}`}`,
            outcome: item.classification,
            misconceptionText: item.misconception,
            correctionText: item.keyFact,
          })
          .run();
      }

      // Notes misconceptions the student no longer holds.
      for (const fix of graded.correctFixes) {
        const candidates = ctx.topics.filter((t) => t.name === fix.topic);
        const match =
          candidates.find((t) => t.history.some((h) => h.misconception === fix.misconception)) ??
          candidates[0];
        if (!match) continue;
        tx.insert(topicEvent)
          .values({
            topicId: topicIdOf(tx, courseId, match.name, match.classNumber),
            source: "grading",
            ref: code,
            outcome: "fixed",
            misconceptionText: fix.misconception,
          })
          .run();
      }

      for (const update of graded.topicUpdates) {
        const topicId = topicIdOf(tx, courseId, update.topic, update.classNumber);
        tx.update(topic).set({ rating: update.rating }).where(eq(topic.id, topicId)).run();
        tx.insert(topicEvent)
          .values({
            topicId,
            source: "grading",
            ref: code,
            outcome: `rating:${update.rating}`,
            correctionText: update.note,
          })
          .run();
      }

      const unresolved = (topicId: number) =>
        tx
          .select()
          .from(backlogItem)
          .where(and(eq(backlogItem.topicId, topicId), isNull(backlogItem.resolvedAt)))
          .get();
      for (const add of graded.backlogAdd) {
        const topicId = topicIdOf(tx, courseId, add.topic, add.classNumber);
        const existing = unresolved(topicId);
        if (existing) {
          tx.update(backlogItem)
            .set({ dueQuiz: add.dueQuiz, reason: add.reason, submissionId })
            .where(eq(backlogItem.id, existing.id))
            .run();
        } else {
          tx.insert(backlogItem)
            .values({
              courseId,
              topicId,
              dueQuiz: add.dueQuiz,
              reason: add.reason,
              submissionId,
            })
            .run();
        }
      }
      for (const resolve of graded.backlogResolve) {
        const existing = unresolved(topicIdOf(tx, courseId, resolve.topic, resolve.classNumber));
        if (existing) {
          tx.update(backlogItem)
            .set({ resolvedAt: new Date() })
            .where(eq(backlogItem.id, existing.id))
            .run();
        }
      }

      tx.delete(nextStep).where(eq(nextStep.courseId, courseId)).run();
      graded.nextSteps.forEach((text, position) => {
        tx.insert(nextStep).values({ courseId, position, text, submissionId }).run();
      });

      for (const text of graded.observations) {
        tx.insert(learnerObservation).values({ text, courseId, submissionId }).run();
      }

      tx.update(generationJob)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      return resultId;
    });
  }

  function markFailed(jobId: number, error: unknown): void {
    try {
      db.update(generationJob)
        .set({ status: "failed", error: describeError(error), finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      emitJob(jobId);
    } catch (persistError) {
      logger.error({ err: persistError, jobId }, "could not mark the grading job as failed");
    }
  }

  async function runGradingJob({
    classId,
    jobId,
    submissionId,
  }: GradingRequestedPayload): Promise<void> {
    let resultId: number;
    try {
      const ctx = loadGradingContext(db, submissionId);
      const graded = await gradeSubmission(ctx, {
        onEvent: progressFor({ classId, jobId, stage: GRADING_STAGE }),
      });
      const violations = checkGradingInvariants(ctx, graded);
      if (violations.length > 0) throw new GradingInvariantError(violations);
      resultId = persist(jobId, ctx, graded);
    } catch (error) {
      logger.error({ err: error, jobId, classId, submissionId }, "grading failed");
      markFailed(jobId, error);
      return;
    }
    // Outside the try: a failure to notify must not turn a saved result into a failed job.
    emitJob(jobId);
    const payload: GradingDonePayload = { submissionId, resultId };
    coordinator.emit(DOMAIN_EVENTS.GRADING_DONE, payload);
  }

  coordinator.on<GradingRequestedPayload>(DOMAIN_EVENTS.GRADING_REQUESTED, runGradingJob);
  if (autoStart) {
    coordinator.on<SubmissionCreatedPayload>(DOMAIN_EVENTS.SUBMISSION_CREATED, onSubmissionCreated);
  }

  return { requestRegrade };
}
