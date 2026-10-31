import type { SemanticEvent } from "@mozaik-ai/core";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { MISCONCEPTION_OUTCOME, type GenerationJob, type LessonDraft } from "@studdy/shared";
import {
  writeLesson as realWriteLesson,
  type LessonSource,
  type LessonWriterInput,
  type LessonWriterOptions,
} from "../agents/lesson-writer.js";
import type { Coordinator, CoordinatorLogger } from "../agents/coordinator.js";
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
import { getClassStatus, getJob } from "../repositories/lessons.js";
import { notFound } from "../routes/errors.js";
import {
  DOMAIN_EVENTS,
  type GenerateRequestedPayload,
  type JobProgressPayload,
  type JobUpdatedPayload,
  type LessonReadyPayload,
} from "./events.js";

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
  /** Minimum gap between two progress events of a job. */
  progressIntervalMs?: number;
}

export interface Pipeline {
  /** Starts the lesson stage for a `draft` or `failed` class. Throws 404/409 `ApiError`s. */
  requestGeneration(classId: number): GenerationJob;
  /** For startup: no job survives a restart, so mark running jobs and generating classes failed. */
  recoverInterruptedJobs(): void;
}

const LESSON_STAGE = "lesson-writer";
const MAX_ERROR_LENGTH = 500;
export const RESTART_ERROR = "Server restarted while generating";

/** Characters of model output carried by one `inference.stream` event (raw Anthropic stream event). */
function streamedChars(event: SemanticEvent): number {
  if (event.type !== "inference.stream") return 0;
  const payload = event.payload as { type?: unknown; delta?: unknown } | undefined;
  if (payload?.type !== "content_block_delta" || typeof payload.delta !== "object") return 0;
  const delta = payload.delta as { type?: unknown; text?: unknown; partial_json?: unknown };
  if (delta.type === "text_delta" && typeof delta.text === "string") return delta.text.length;
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return delta.partial_json.length;
  }
  return 0;
}

function describeError(error: unknown): string {
  const message =
    error instanceof StageError
      ? `Lesson writer failed (${error.kind}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

export function createPipeline({
  db,
  coordinator,
  logger,
  writeLesson = realWriteLesson,
  progressIntervalMs = 500,
}: PipelineOptions): Pipeline {
  function emitJob(jobId: number): void {
    const job = getJob(db, jobId);
    if (!job) return; // the class was deleted meanwhile
    const classStatus = getClassStatus(db, job.classId);
    if (!classStatus) return;
    const payload: JobUpdatedPayload = { type: "job", job, classStatus };
    coordinator.emit(DOMAIN_EVENTS.JOB_UPDATED, payload);
  }

  function requestGeneration(classId: number): GenerationJob {
    const jobId = db.transaction((tx) => {
      const cls = tx.select().from(classTable).where(eq(classTable.id, classId)).get();
      if (!cls) throw notFound("Class");
      if (cls.status === "generating") throw new ConflictError("The class is already generating");
      if (cls.status === "ready") throw new ConflictError("The class is already generated");

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
      let outputChars = 0;
      let lastProgressAt = 0;
      const draft = await writeLesson(input, {
        onEvent: (event) => {
          const chars = streamedChars(event);
          if (chars === 0) return;
          outputChars += chars;
          const now = Date.now();
          if (now - lastProgressAt < progressIntervalMs) return;
          lastProgressAt = now;
          const payload: JobProgressPayload = {
            type: "progress",
            classId,
            jobId,
            stage: LESSON_STAGE,
            outputChars,
          };
          coordinator.emit(DOMAIN_EVENTS.JOB_PROGRESS, payload);
        },
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

  return { requestGeneration, recoverInterruptedJobs };
}
