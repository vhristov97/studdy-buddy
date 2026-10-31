import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { MISCONCEPTION_OUTCOME, type GenerationJob, type LessonDraft } from "@studdy/shared";
import {
  writeLesson as realWriteLesson,
  type LessonSource,
  type LessonWriterInput,
  type LessonWriterOptions,
} from "../agents/lesson-writer.js";
import type { Coordinator, CoordinatorLogger } from "../agents/coordinator.js";
import { gradeSubmission as realGradeSubmission } from "../agents/grader.js";
import { StageError } from "../agents/stage.js";
import type { Db } from "../db/client.js";
import {
  classTable,
  course,
  generationJob,
  lesson,
  material,
  topic,
  topicEvent,
} from "../db/schema.js";
import { ConflictError } from "../repositories/conflict.js";
import { getJob } from "../repositories/lessons.js";
import { notFound } from "../routes/errors.js";
import { createJobEmitter, createProgressReporter, truncate } from "./common.js";
import { registerGradingBranch } from "./grading-branch.js";
import { registerQuizBranch, type QuizAgents } from "./quiz-branch.js";
import { registerVizBranch, type VizAgents } from "./viz-branch.js";
import { DOMAIN_EVENTS, type GenerateRequestedPayload, type LessonReadyPayload } from "./events.js";

export type WriteLesson = (
  input: LessonWriterInput,
  opts?: LessonWriterOptions,
) => Promise<LessonDraft>;

export interface PipelineOptions {
  db: Db;
  coordinator: Coordinator;
  logger: CoordinatorLogger;
  /** Replaceable in tests. */
  writeLesson?: WriteLesson;
  /** Replaceable in tests: the planner, builder session and reviewer of the quiz branch. */
  quizAgents?: Partial<QuizAgents>;
  /** Off: no quiz job starts on `lesson.ready` (lesson-only tests). Default on. */
  quizAutoStart?: boolean;
  /** Replaceable in tests: the grader agent. */
  gradeSubmission?: typeof realGradeSubmission;
  /** Off: no grading job starts on `submission.created`. Default on. */
  gradingAutoStart?: boolean;
  /** Replaceable in tests: the agents of the viz branch (identifier, planner, builder session, reviewer). */
  vizAgents?: Partial<VizAgents>;
  /** Off: no `viz_topics` job starts on `lesson.ready`. Default on. */
  vizAutoStart?: boolean;
  /** Minimum gap between two progress events of a job. */
  progressIntervalMs?: number;
}

export interface Pipeline {
  /** Starts the lesson stage for a `draft` or `failed` class. Throws 404/409 `ApiError`s. */
  requestGeneration(classId: number): GenerationJob;
  /**
   * Starts, or re-plans and rebuilds, the quiz of a `ready` class with no released quiz whose
   * latest quiz job failed or is absent (the quiz branch itself starts on `lesson.ready`). Throws
   * 404/409 `ApiError`s.
   */
  requestQuizRegeneration(classId: number): GenerationJob;
  /**
   * Grades a submission that has no result and whose latest grading job failed or is absent.
   * Throws 404/409 `ApiError`s.
   */
  requestGrading(submissionId: number): GenerationJob;
   * Reruns the viz-topic identifier of a `ready` class whose latest `viz_topics` job failed or is
   * absent (classes generated before M7). Throws 404/409 `ApiError`s.
   */
  requestVizTopicsRegeneration(classId: number): GenerationJob;
  /**
   * Rebuilds a selected visualization suggestion from scratch (re-plan + re-build) when it has no
   * released visualization and its latest `viz` job failed. Throws 404/409 `ApiError`s.
   */
  requestVizRegeneration(suggestionId: number): GenerationJob;
  /**
   * For startup: no job survives a restart, so mark running jobs and generating classes failed.
   * A `ready` class stays `ready` when only its quiz job was running.
   */
  recoverInterruptedJobs(): void;
}

const LESSON_STAGE = "lesson-writer";
export const RESTART_ERROR = "Server restarted while generating";

function describeError(error: unknown): string {
  const message =
    error instanceof StageError
      ? `Lesson writer failed (${error.kind}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return truncate(message);
}

export function createPipeline({
  db,
  coordinator,
  logger,
  writeLesson = realWriteLesson,
  quizAgents,
  quizAutoStart = true,
  gradeSubmission,
  gradingAutoStart = true,
  vizAgents,
  vizAutoStart = true,
  progressIntervalMs = 500,
}: PipelineOptions): Pipeline {
  const emitJob = createJobEmitter(db, coordinator);
  const progressFor = createProgressReporter(coordinator, progressIntervalMs);

  function requestGeneration(classId: number): GenerationJob {
    const jobId = db.transaction((tx) => {
      const cls = tx.select().from(classTable).where(eq(classTable.id, classId)).get();
      if (!cls) throw notFound("Class");
      if (cls.status === "generating") throw new ConflictError("The class is already generating");
      if (cls.status === "ready") throw new ConflictError("The class is already generated");

      // Materials lock after generation, so a file whose text could not be extracted would be lost.
      const unreadable = tx
        .select({ originalName: material.originalName })
        .from(material)
        .where(and(eq(material.classId, classId), eq(material.extractionStatus, "failed")))
        .orderBy(asc(material.originalName))
        .all();
      if (unreadable.length > 0) {
        throw new ConflictError(
          `Remove or replace the files whose text could not be extracted before generating: ${unreadable
            .map((f) => f.originalName)
            .join(", ")}`,
        );
      }

      const usable = tx
        .select({ id: material.id })
        .from(material)
        .where(
          and(
            eq(material.classId, classId),
            eq(material.kind, "material"),
            eq(material.extractionStatus, "ok"),
            isNotNull(material.extractedText),
          ),
        )
        .limit(1)
        .get();
      if (!usable) {
        throw new ConflictError(
          "The class has no class materials with successfully extracted text to generate from",
        );
      }

      const previous = tx
        .select()
        .from(generationJob)
        .where(and(eq(generationJob.classId, classId), eq(generationJob.kind, "lesson")))
        .orderBy(desc(generationJob.id))
        .limit(1)
        .get();
      tx.update(classTable).set({ status: "generating" }).where(eq(classTable.id, classId)).run();
      return tx
        .insert(generationJob)
        .values({
          classId,
          kind: "lesson",
          stage: LESSON_STAGE,
          status: "running",
          attempt: (previous?.attempt ?? 0) + 1,
          parentJobId: previous?.status === "failed" ? previous.id : null,
        })
        .returning({ id: generationJob.id })
        .get().id;
    });

    emitJob(jobId);
    const payload: GenerateRequestedPayload = { classId, jobId };
    coordinator.emit(DOMAIN_EVENTS.GENERATE_REQUESTED, payload);
    return getJob(db, jobId)!;
  }

  function loadLessonInput(classId: number): LessonWriterInput {
    const row = db
      .select({ cls: classTable, course })
      .from(classTable)
      .innerJoin(course, eq(course.id, classTable.courseId))
      .where(eq(classTable.id, classId))
      .get();
    if (!row) throw new Error("The class no longer exists");
    const files = db
      .select()
      .from(material)
      .where(eq(material.classId, classId))
      .orderBy(asc(material.originalName), asc(material.id))
      .all();
    const sourcesOf = (kind: "material" | "note"): LessonSource[] =>
      files
        .filter((f) => f.kind === kind && f.extractionStatus === "ok" && f.extractedText !== null)
        .map((f) => ({ name: f.originalName, text: f.extractedText ?? "" }));
    return {
      course: {
        name: row.course.name,
        persona: row.course.persona,
        assessmentFormat: row.course.assessmentFormat,
      },
      class: { number: row.cls.number, title: row.cls.title },
      materials: sourcesOf("material"),
      notes: sourcesOf("note"),
    };
  }

  /** One transaction: lesson, topics, notes events, job succeeded, class ready. */
  function persistLesson(jobId: number, classId: number, draft: LessonDraft): number {
    return db.transaction((tx) => {
      const cls = tx.select().from(classTable).where(eq(classTable.id, classId)).get();
      if (!cls) throw new Error("The class no longer exists");
      const lessonId = tx
        .insert(lesson)
        .values({ classId, bodyMd: draft.lessonMd })
        .returning({ id: lesson.id })
        .get().id;
      draft.topics.forEach((t, position) => {
        const topicId = tx
          .insert(topic)
          .values({
            courseId: cls.courseId,
            classId,
            name: t.name,
            position,
            deferred: t.deferred,
            deferredNote: t.deferredNote,
          })
          .returning({ id: topic.id })
          .get().id;
        for (const m of t.misconceptions) {
          tx.insert(topicEvent)
            .values({
              topicId,
              source: "notes",
              outcome: MISCONCEPTION_OUTCOME,
              misconceptionText: m.claim,
              correctionText: m.correction,
            })
            .run();
        }
      });
      tx.update(generationJob)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      tx.update(classTable).set({ status: "ready" }).where(eq(classTable.id, classId)).run();
      return lessonId;
    });
  }

  function markFailed(jobId: number, classId: number, error: unknown): void {
    try {
      db.transaction((tx) => {
        tx.update(generationJob)
          .set({ status: "failed", error: describeError(error), finishedAt: new Date() })
          .where(eq(generationJob.id, jobId))
          .run();
        tx.update(classTable).set({ status: "failed" }).where(eq(classTable.id, classId)).run();
      });
      emitJob(jobId);
    } catch (persistError) {
      logger.error({ err: persistError, jobId, classId }, "could not mark the job as failed");
    }
  }

  async function runLessonJob({ classId, jobId }: GenerateRequestedPayload): Promise<void> {
    let lessonId: number;
    try {
      const input = loadLessonInput(classId);
      const draft = await writeLesson(input, {
        onEvent: progressFor({ classId, jobId, stage: LESSON_STAGE }),
      });
      lessonId = persistLesson(jobId, classId, draft);
    } catch (error) {
      logger.error({ err: error, jobId, classId }, "lesson generation failed");
      markFailed(jobId, classId, error);
      return;
    }
    // Outside the try: a failure to notify must not turn a saved lesson into a failed job.
    emitJob(jobId);
    const payload: LessonReadyPayload = { classId, lessonId };
    coordinator.emit(DOMAIN_EVENTS.LESSON_READY, payload);
  }

  coordinator.on<GenerateRequestedPayload>(DOMAIN_EVENTS.GENERATE_REQUESTED, runLessonJob);
  const quizBranch = registerQuizBranch({
    db,
    coordinator,
    logger,
    ...(quizAgents && { agents: quizAgents }),
    progressIntervalMs,
    autoStart: quizAutoStart,
  });
  const gradingBranch = registerGradingBranch({
    db,
    coordinator,
    logger,
    ...(gradeSubmission && { gradeSubmission }),
    progressIntervalMs,
    autoStart: gradingAutoStart,
  });
  const vizBranch = registerVizBranch({
    db,
    coordinator,
    logger,
    ...(vizAgents && { agents: vizAgents }),
    progressIntervalMs,
    autoStart: vizAutoStart,
  });

  function recoverInterruptedJobs(): void {
    db.transaction((tx) => {
      tx.update(generationJob)
        .set({ status: "failed", error: RESTART_ERROR, finishedAt: new Date() })
        .where(eq(generationJob.status, "running"))
        .run();
      tx.update(classTable)
        .set({ status: "failed" })
        .where(eq(classTable.status, "generating"))
        .run();
    });
  }

  return {
    requestGeneration,
    requestQuizRegeneration: quizBranch.requestRegeneration,
    requestGrading: gradingBranch.requestRegrade,
    requestVizTopicsRegeneration: vizBranch.requestTopicsRegeneration,
    requestVizRegeneration: vizBranch.requestVizRegeneration,
    recoverInterruptedJobs,
  };
}
