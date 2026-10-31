import type { GenerationJob, JobKind } from "@studdy/shared";

/** Label per job kind. */
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  lesson: "Objedinjene beleške",
  quiz: "Kviz",
  grading: "Ocenjivanje",
  viz_topics: "Predlozi vizualizacija",
  viz: "Vizualizacija",
};

/** Pipeline position of each kind; the panel lists its rows in this order. */
export const JOB_KIND_ORDER: readonly JobKind[] = ["lesson", "quiz", "grading", "viz_topics", "viz"];

/** Step label per stage name, given the review cycle of the job. */
const STAGE_LABELS: Record<string, (cycle: number | null) => string> = {
  "viz-identifier": () => "Traženje tema",
  "viz-planner": () => "Planiranje",
  "viz-builder": (cycle) => (cycle === null ? "Izrada" : `Ispravke (krug ${cycle})`),
  "viz-reviewer": (cycle) => `Provera (krug ${cycle ?? 1})`,
  "quiz-planner": () => "Planiranje",
  "quiz-builder": (cycle) => (cycle === null ? "Izrada" : `Ispravke (krug ${cycle})`),
  "quiz-reviewer": (cycle) => `Provera (krug ${cycle ?? 1})`,
  grader: () => "Ocenjivanje",
};

/** The current step of a job, or null for stages that need no detail (the lesson). */
export function stageLabel(job: Pick<GenerationJob, "stage" | "cycle">): string | null {
  return STAGE_LABELS[job.stage]?.(job.cycle) ?? null;
}

/**
 * Jobs from the query and from the live stream, newest first. The stream wins unless the query
 * already saw the job finish while the stream's copy is still "running" (e.g. after a reconnect).
 */
export function mergeJobs(
  fetched: readonly GenerationJob[],
  live: ReadonlyMap<number, GenerationJob>,
  classId: number,
): GenerationJob[] {
  const merged = new Map(fetched.map((job) => [job.id, job]));
  for (const job of live.values()) {
    if (job.classId !== classId) continue;
    const current = merged.get(job.id);
    if (current && current.status !== "running" && job.status === "running") continue;
    merged.set(job.id, job);
  }
  return [...merged.values()].sort((a, b) => b.id - a.id);
}

export interface JobGroup {
  /** Unique per group: the kind, plus the submission for grading (one group per graded submission). */
  key: string;
  kind: JobKind;
  /** The visualization suggestion of a `viz` group; null for other kinds. */
  suggestionId: number | null;
  latest: GenerationJob;
  /** Older attempts, newest first. */
  earlier: GenerationJob[];
}

/**
 * One group per kind, in pipeline order (lesson first). Grading is one group per submission, the
 * newest submission first. `viz` jobs build one visualization each, so they get a group per
 * suggestion (by suggestion id).
 */
export function groupJobs(jobs: readonly GenerationJob[]): JobGroup[] {
  const byKey = new Map<string, GenerationJob[]>();
  for (const job of jobs) {
    const key =
      job.kind === "viz"
        ? `viz-${job.suggestionId}`
        : job.submissionId === null
          ? job.kind
          : `${job.kind}-${job.submissionId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), job]);
  }
  return [...byKey.entries()]
    .map(([key, list]) => ({
      key,
      kind: list[0]!.kind,
      suggestionId: list[0]!.kind === "viz" ? list[0]!.suggestionId : null,
      latest: list[0]!,
      earlier: list.slice(1),
    }))
    .sort(
      (a, b) =>
        JOB_KIND_ORDER.indexOf(a.kind) - JOB_KIND_ORDER.indexOf(b.kind) ||
        (a.kind === "viz"
          ? (a.suggestionId ?? 0) - (b.suggestionId ?? 0)
          : b.latest.id - a.latest.id),
    );
}

/** Row label of a job; a `viz` job names its topic once the suggestions are known. */
export function jobLabel(
  job: Pick<GenerationJob, "kind" | "suggestionId">,
  concepts?: ReadonlyMap<number, string>,
): string {
  if (job.kind !== "viz") return JOB_KIND_LABELS[job.kind];
  const concept = job.suggestionId === null ? undefined : concepts?.get(job.suggestionId);
  return concept ? `${JOB_KIND_LABELS.viz}: ${concept}` : JOB_KIND_LABELS.viz;
}
