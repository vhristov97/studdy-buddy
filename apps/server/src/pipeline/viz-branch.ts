import { and, desc, eq } from "drizzle-orm";
import {
  validateVizHtml,
  type GenerationJob,
  type VizDraft,
  type VizPlan,
  type VizReview,
  type VizSuggestions,
} from "@studdy/shared";
import type { Coordinator, CoordinatorLogger } from "../agents/coordinator.js";
import {
  buildVizBuilderMessage,
  buildVizFixMessage,
  openVizBuilderSession as realOpenVizBuilderSession,
} from "../agents/viz-builder.js";
import { identifyVizTopics as realIdentifyVizTopics } from "../agents/viz-identifier.js";
import { planViz as realPlanViz } from "../agents/viz-planner.js";
import { reviewViz as realReviewViz } from "../agents/viz-reviewer.js";
import { StageError, type StageSession } from "../agents/stage.js";
import type { Db } from "../db/client.js";
import {
  classTable,
  generationJob,
  visualization,
  vizBuild,
  vizSuggestion,
  type VizBuildLogEntry,
} from "../db/schema.js";
import { loadQuizContext } from "../quiz/context.js";
import { ConflictError } from "../repositories/conflict.js";
import { getJob } from "../repositories/lessons.js";
import { notFound } from "../routes/errors.js";
import { createJobEmitter, createProgressReporter, truncate } from "./common.js";
import {
  DOMAIN_EVENTS,
  type LessonReadyPayload,
  type VizReleasedPayload,
  type VizRequestedPayload,
  type VizSelectedPayload,
  type VizTopicsRequestedPayload,
} from "./events.js";
import { MAX_FIX_CYCLES } from "./quiz-branch.js";

/** The agent calls of the viz branch; replaceable in tests. */
export interface VizAgents {
  identifyVizTopics: typeof realIdentifyVizTopics;
  planViz: typeof realPlanViz;
  openVizBuilderSession: typeof realOpenVizBuilderSession;
  reviewViz: typeof realReviewViz;
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
  /**
   * Rebuilds a selected suggestion from scratch (re-plan + re-build) when it has no released
   * visualization and its latest `viz` job failed (or none ever started). Throws 404/409
   * `ApiError`s.
   */
  requestVizRegeneration(suggestionId: number): GenerationJob;
}

export const VIZ_STAGES = {
  identifier: "viz-identifier",
  planner: "viz-planner",
  builder: "viz-builder",
  reviewer: "viz-reviewer",
} as const;

const SUMMARY_LENGTH = 300;

class VizReviewFailedError extends Error {
  constructor(summary: string) {
    super(
      `Viz review did not pass after ${MAX_FIX_CYCLES} fix cycles: ${truncate(summary, SUMMARY_LENGTH)}`,
    );
    this.name = "VizReviewFailedError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function registerVizBranch({
  db,
  coordinator,
  logger,
  agents,
  progressIntervalMs = 500,
  autoStart = true,
}: VizBranchOptions): VizBranch {
  const { identifyVizTopics, planViz, openVizBuilderSession, reviewViz }: VizAgents = {
    identifyVizTopics: realIdentifyVizTopics,
    planViz: realPlanViz,
    openVizBuilderSession: realOpenVizBuilderSession,
    reviewViz: realReviewViz,
    ...agents,
  };
  const emitJob = createJobEmitter(db, coordinator);
  const progressFor = createProgressReporter(coordinator, progressIntervalMs);

  function describeTopicsError(error: unknown): string {
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
        .set({ status: "failed", error: describeTopicsError(error), finishedAt: new Date() })
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

  // ---- visualization builds: one `viz` job per selected suggestion ----

  function describeVizError(stage: string, error: unknown): string {
    if (error instanceof VizReviewFailedError) return truncate(error.message);
    const name = stage.replace(/^viz-/, "");
    const message =
      error instanceof StageError
        ? `Viz ${name} failed (${error.kind}): ${error.message}`
        : `Viz ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    return truncate(message);
  }

  function latestVizJob(tx: Tx, suggestionId: number) {
    return tx
      .select()
      .from(generationJob)
      .where(and(eq(generationJob.kind, "viz"), eq(generationJob.suggestionId, suggestionId)))
      .orderBy(desc(generationJob.id))
      .limit(1)
      .get();
  }

  /** The viz_topics job of the class (the suggestions' origin), else its lesson job. */
  function vizJobParent(tx: Tx, classId: number): number | null {
    return latestJob(tx, classId, "viz_topics")?.id ?? latestJob(tx, classId, "lesson")?.id ?? null;
  }

  /** Inserts a running `viz` job for the suggestion. Call inside a transaction. */
  function insertVizJob(
    tx: Tx,
    classId: number,
    suggestionId: number,
    parentJobId: number | null,
  ): number {
    const previous = latestVizJob(tx, suggestionId);
    return tx
      .insert(generationJob)
      .values({
        classId,
        kind: "viz",
        stage: VIZ_STAGES.planner,
        status: "running",
        attempt: (previous?.attempt ?? 0) + 1,
        parentJobId,
        suggestionId,
      })
      .returning({ id: generationJob.id })
      .get().id;
  }

  function hasVisualization(tx: Tx, suggestionId: number): boolean {
    return (
      tx
        .select({ id: visualization.id })
        .from(visualization)
        .where(eq(visualization.suggestionId, suggestionId))
        .limit(1)
        .get() !== undefined
    );
  }

  function requestVizRegeneration(suggestionId: number): GenerationJob {
    const { jobId, classId } = db.transaction((tx) => {
      const suggestion = tx
        .select()
        .from(vizSuggestion)
        .where(eq(vizSuggestion.id, suggestionId))
        .get();
      if (!suggestion) throw notFound("Visualization suggestion");
      if (!suggestion.selected) {
        throw new ConflictError("The visualization suggestion was not selected");
      }
      if (hasVisualization(tx, suggestionId)) {
        throw new ConflictError("The visualization already exists");
      }
      const last = latestVizJob(tx, suggestionId);
      if (last?.status === "running") {
        throw new ConflictError("The visualization is already being built");
      }
      if (last && last.status !== "failed") {
        throw new ConflictError("The visualization was already built");
      }
      return {
        jobId: insertVizJob(
          tx,
          suggestion.classId,
          suggestionId,
          last?.id ?? vizJobParent(tx, suggestion.classId),
        ),
        classId: suggestion.classId,
      };
    });
    emitJob(jobId);
    const payload: VizRequestedPayload = { classId, jobId, suggestionId };
    coordinator.emit(DOMAIN_EVENTS.VIZ_REQUESTED, payload);
    return getJob(db, jobId)!;
  }

  /** `viz.selected`: opens one `viz` job per suggestion; the jobs then run in parallel. */
  function startVizJobs({ classId, suggestionIds }: VizSelectedPayload): void {
    for (const suggestionId of suggestionIds) {
      try {
        const jobId = db.transaction((tx) => {
          const suggestion = tx
            .select()
            .from(vizSuggestion)
            .where(eq(vizSuggestion.id, suggestionId))
            .get();
          if (!suggestion || suggestion.classId !== classId || !suggestion.selected) return null;
          if (latestVizJob(tx, suggestionId) || hasVisualization(tx, suggestionId)) return null;
          return insertVizJob(tx, classId, suggestionId, vizJobParent(tx, classId));
        });
        if (jobId === null) continue;
        emitJob(jobId);
        const payload: VizRequestedPayload = { classId, jobId, suggestionId };
        coordinator.emit(DOMAIN_EVENTS.VIZ_REQUESTED, payload);
      } catch (error) {
        logger.error({ err: error, classId, suggestionId }, "could not start the viz job");
      }
    }
  }

  function setStage(jobId: number, stage: string, cycle: number | null): void {
    db.update(generationJob).set({ stage, cycle }).where(eq(generationJob.id, jobId)).run();
    emitJob(jobId);
  }

  /** One transaction: the visualization, the build's link to it, the job succeeded. */
  function release(
    jobId: number,
    classId: number,
    suggestionId: number,
    buildId: number,
    plan: VizPlan,
    html: string,
  ): number {
    return db.transaction((tx) => {
      if (hasVisualization(tx, suggestionId)) {
        throw new Error("The suggestion already has a released visualization");
      }
      const taken = new Set(
        tx
          .select({ slug: visualization.slug })
          .from(visualization)
          .where(eq(visualization.classId, classId))
          .all()
          .map((r) => r.slug),
      );
      let slug = plan.slug;
      for (let n = 2; taken.has(slug); n++) slug = `${plan.slug}-${n}`;
      const visualizationId = tx
        .insert(visualization)
        .values({ classId, suggestionId, slug, title: plan.title, html, jobId })
        .returning({ id: visualization.id })
        .get().id;
      tx.update(vizBuild).set({ visualizationId }).where(eq(vizBuild.id, buildId)).run();
      tx.update(generationJob)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      return visualizationId;
    });
  }

  function markVizFailed(jobId: number, stage: string, error: unknown): void {
    try {
      db.update(generationJob)
        .set({ status: "failed", error: describeVizError(stage, error), finishedAt: new Date() })
        .where(eq(generationJob.id, jobId))
        .run();
      emitJob(jobId);
    } catch (persistError) {
      logger.error({ err: persistError, jobId }, "could not mark the viz job as failed");
    }
  }

  async function runVizJob({ classId, jobId, suggestionId }: VizRequestedPayload): Promise<void> {
    let stage: string = VIZ_STAGES.planner;
    let session: StageSession<VizDraft> | undefined;
    let visualizationId: number;
    try {
      const ctx = loadQuizContext(db, classId);
      const suggestion = db
        .select()
        .from(vizSuggestion)
        .where(eq(vizSuggestion.id, suggestionId))
        .get();
      if (!suggestion) throw new Error("The visualization suggestion no longer exists");

      const plan = await planViz(
        {
          ctx,
          suggestion: {
            concept: suggestion.concept,
            section: suggestion.section,
            misconception: suggestion.misconception,
            summary: suggestion.summary,
            controls: suggestion.controlsJson,
            scenarios: suggestion.scenariosJson,
            origin: suggestion.origin,
          },
        },
        { onEvent: progressFor({ classId, jobId, stage: VIZ_STAGES.planner }) },
      );

      const log: VizBuildLogEntry[] = [];
      const buildId = db
        .insert(vizBuild)
        .values({ jobId, suggestionId, planJson: plan, logJson: log })
        .returning({ id: vizBuild.id })
        .get().id;
      const saveProgress = (html?: string): void => {
        db.update(vizBuild)
          .set({ logJson: log, ...(html !== undefined && { draftHtml: html }) })
          .where(eq(vizBuild.id, buildId))
          .run();
      };

      stage = VIZ_STAGES.builder;
      setStage(jobId, stage, null);
      session = openVizBuilderSession(plan, {
        onEvent: progressFor({ classId, jobId, stage: VIZ_STAGES.builder }),
      });
      let draft = await session.send(buildVizBuilderMessage({ plan, lessonMd: ctx.lessonMd }));
      saveProgress(draft.html);

      for (let cycle = 1; ; cycle++) {
        stage = VIZ_STAGES.reviewer;
        setStage(jobId, stage, cycle);
        const report = validateVizHtml(draft.html);
        const entry: VizBuildLogEntry = { cycle, report, review: null, notes: draft.notes };
        log.push(entry);
        saveProgress();
        // Contract errors are fixed first; the schema normally keeps them out of the draft.
        const review: VizReview =
          report.errors.length > 0
            ? {
                approved: false,
                summary: `Design contract errors: ${report.errors.map((e) => e.code).join(", ")}`,
                fixes: report.errors.map((e) => ({
                  area: "design contract",
                  problem: e.message,
                  change: `Fix [${e.code}].`,
                })),
              }
            : await reviewViz(
                { plan, html: draft.html, notes: draft.notes, lessonMd: ctx.lessonMd, report },
                { onEvent: progressFor({ classId, jobId, stage: VIZ_STAGES.reviewer }) },
              );
        entry.review = review;
        saveProgress();
        if (review.approved) break;
        if (cycle > MAX_FIX_CYCLES) throw new VizReviewFailedError(review.summary);

        stage = VIZ_STAGES.builder;
        setStage(jobId, stage, cycle);
        draft = await session.send(buildVizFixMessage(review.fixes, report));
        saveProgress(draft.html);
      }

      visualizationId = release(jobId, classId, suggestionId, buildId, plan, draft.html);
    } catch (error) {
      logger.error({ err: error, jobId, classId, suggestionId, stage }, "viz generation failed");
      markVizFailed(jobId, stage, error);
      return;
    } finally {
      session?.close();
    }
    // Outside the try: a failure to notify must not turn a released visualization into a failed job.
    emitJob(jobId);
    const payload: VizReleasedPayload = { classId, visualizationId, suggestionId };
    coordinator.emit(DOMAIN_EVENTS.VIZ_RELEASED, payload);
  }

  coordinator.on<VizTopicsRequestedPayload>(DOMAIN_EVENTS.VIZ_TOPICS_REQUESTED, runJob);
  coordinator.on<VizSelectedPayload>(DOMAIN_EVENTS.VIZ_SELECTED, startVizJobs);
  coordinator.on<VizRequestedPayload>(DOMAIN_EVENTS.VIZ_REQUESTED, runVizJob);
  if (autoStart) coordinator.on<LessonReadyPayload>(DOMAIN_EVENTS.LESSON_READY, startJob);

  return { requestTopicsRegeneration, requestVizRegeneration };
}
