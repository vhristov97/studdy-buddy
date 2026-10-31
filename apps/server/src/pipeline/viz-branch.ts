import { and, desc, eq } from "drizzle-orm";
import type { GenerationJob, VizSuggestions } from "@studdy/shared";
import type { Coordinator, CoordinatorLogger } from "../agents/coordinator.js";
import { identifyVizTopics as realIdentifyVizTopics } from "../agents/viz-identifier.js";
import { StageError } from "../agents/stage.js";
import type { Db } from "../db/client.js";
import { classTable, generationJob, vizSuggestion } from "../db/schema.js";
import { loadQuizContext } from "../quiz/context.js";
import { ConflictError } from "../repositories/conflict.js";
import { getJob } from "../repositories/lessons.js";
import { notFound } from "../routes/errors.js";
import { createJobEmitter, createProgressReporter, truncate } from "./common.js";
import {
  DOMAIN_EVENTS,
  type LessonReadyPayload,
  type VizTopicsRequestedPayload,
} from "./events.js";

/** The agent calls of the viz branch; replaceable in tests. */
export interface VizAgents {
  identifyVizTopics: typeof realIdentifyVizTopics;
}

export interface VizBranchOptions {
  db: Db;
  coordinator: Coordinator;
  logger: CoordinatorLogger;
  agents?: Partial<VizAgents>;
  /** Minimum gap between two progress events of a job. */
  progressIntervalMs?: number;
  /** Start a `viz_topics` job on every `lesson.ready` (default). Off: only regeneration starts one. */
  autoStart?: boolean;
}

export interface VizBranch {
  /**
   * Reruns the topic identifier for a `ready` class whose latest `viz_topics` job failed or does
   * not exist (classes generated before M7). Throws 404/409 `ApiError`s.
   */
  requestTopicsRegeneration(classId: number): GenerationJob;
}

export const VIZ_STAGES = { identifier: "viz-identifier" } as const;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function registerVizBranch({
  db,
  coordinator,
  logger,
  agents,
  progressIntervalMs = 500,
  autoStart = true,
}: VizBranchOptions): VizBranch {
  const { identifyVizTopics }: VizAgents = {
    identifyVizTopics: realIdentifyVizTopics,
    ...agents,
  };
  const emitJob = createJobEmitter(db, coordinator);
  const progressFor = createProgressReporter(coordinator, progressIntervalMs);

  function describeError(error: unknown): string {
    const message =
      error instanceof StageError
        ? `Viz topic identifier failed (${error.kind}): ${error.message}`
        : `Viz topic identifier failed: ${error instanceof Error ? error.message : String(error)}`;
    return truncate(message);
  }

  function latestJob(tx: Tx, classId: number, kind: "lesson" | "viz_topics") {
    return tx
      .select()
      .from(generationJob)
      .where(and(eq(generationJob.classId, classId), eq(generationJob.kind, kind)))
      .orderBy(desc(generationJob.id))
      .limit(1)
      .get();
  }

  /** Inserts a running `viz_topics` job. Call inside a transaction. */
  function insertJob(tx: Tx, classId: number, parentJobId: number | null): number {
    const previous = latestJob(tx, classId, "viz_topics");
    return tx
      .insert(generationJob)
      .values({
        classId,
        kind: "viz_topics",
        stage: VIZ_STAGES.identifier,
        status: "running",
        attempt: (previous?.attempt ?? 0) + 1,
        parentJobId,
      })
      .returning({ id: generationJob.id })
      .get().id;
  }

  function requestTopicsRegeneration(classId: number): GenerationJob {
    const jobId = db.transaction((tx) => {
      const cls = tx.select().from(classTable).where(eq(classTable.id, classId)).get();
      if (!cls) throw notFound("Class");
      if (cls.status !== "ready") throw new ConflictError("The class has no finished lesson");
      const last = latestJob(tx, classId, "viz_topics");
      if (last?.status === "running") {
        throw new ConflictError("The visualization topics are already being identified");
      }
      if (last && last.status !== "failed") {
        throw new ConflictError("The visualization topics were already identified");
      }
      return insertJob(tx, classId, last?.id ?? latestJob(tx, classId, "lesson")?.id ?? null);
    });
    emitJob(jobId);
    const payload: VizTopicsRequestedPayload = { classId, jobId };
    coordinator.emit(DOMAIN_EVENTS.VIZ_TOPICS_REQUESTED, payload);
    return getJob(db, jobId)!;
  }

  /** `lesson.ready`: opens the `viz_topics` job of the freshly generated class. */
  function startJob({ classId }: LessonReadyPayload): void {
    const jobId = db.transaction((tx) =>
      insertJob(tx, classId, latestJob(tx, classId, "lesson")?.id ?? null),
    );
    emitJob(jobId);
    const payload: VizTopicsRequestedPayload = { classId, jobId };
    coordinator.emit(DOMAIN_EVENTS.VIZ_TOPICS_REQUESTED, payload);
  }

  function existingTopics(classId: number) {
    return db
      .select({
        concept: vizSuggestion.concept,
        origin: vizSuggestion.origin,
        selected: vizSuggestion.selected,
      })
      .from(vizSuggestion)
      .where(eq(vizSuggestion.classId, classId))
      .all();
  }

  /** One transaction: the suggestions and the job succeeded. */
  function persist(jobId: number, classId: number, result: VizSuggestions): void {
    db.transaction((tx) => {
      for (const s of result.suggestions) {
        tx.insert(vizSuggestion)
          .values({
            classId,
            concept: s.concept,
            section: s.section,
            misconception: s.misconception,
            summary: s.summary,
            controlsJson: s.controls,
            scenariosJson: s.scenarios,
            origin: "agent",
            jobId,
          })
          .run();
      }
      tx.update(generationJob)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
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
      logger.error({ err: persistError, jobId }, "could not mark the viz topics job as failed");
    }
  }

  async function runJob({ classId, jobId }: VizTopicsRequestedPayload): Promise<void> {
    try {
      const ctx = loadQuizContext(db, classId);
      const result = await identifyVizTopics(
        { ctx, existing: existingTopics(classId) },
        { onEvent: progressFor({ classId, jobId, stage: VIZ_STAGES.identifier }) },
      );
      persist(jobId, classId, result);
    } catch (error) {
      logger.error({ err: error, jobId, classId }, "viz topic identification failed");
      markFailed(jobId, error);
      return;
    }
    // Outside the try: a failure to notify must not turn saved suggestions into a failed job.
    emitJob(jobId);
  }

  coordinator.on<VizTopicsRequestedPayload>(DOMAIN_EVENTS.VIZ_TOPICS_REQUESTED, runJob);
  if (autoStart) coordinator.on<LessonReadyPayload>(DOMAIN_EVENTS.LESSON_READY, startJob);

  return { requestTopicsRegeneration };
}
