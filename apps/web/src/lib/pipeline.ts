import type { GenerationJob, JobKind } from "@studdy/shared";

/** Label per job kind. */
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  lesson: "Objedinjene beleške",
  quiz: "Kviz",
  viz_topics: "Predlozi vizualizacija",
  viz: "Vizualizacija",
};

/** Pipeline position of each kind; the panel lists its rows in this order. */
export const JOB_KIND_ORDER: readonly JobKind[] = ["lesson", "quiz", "viz_topics", "viz"];

/** Step label per stage name, given the review cycle of the job. */
const STAGE_LABELS: Record<string, (cycle: number | null) => string> = {
  "viz-identifier": () => "Traženje tema",
  "viz-planner": () => "Planiranje",
  "viz-builder": (cycle) => (cycle === null ? "Izrada" : `Ispravke (krug ${cycle})`),
  "viz-reviewer": (cycle) => `Provera (krug ${cycle ?? 1})`,
  "quiz-planner": () => "Planiranje",
  "quiz-builder": (cycle) => (cycle === null ? "Izrada" : `Ispravke (krug ${cycle})`),
  "quiz-reviewer": (cycle) => `Provera (krug ${cycle ?? 1})`,
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
  kind: JobKind;
  latest: GenerationJob;
  /** Older attempts, newest first. */
  earlier: GenerationJob[];
}

/** One group per kind, in pipeline order (lesson first). */
export function groupJobs(jobs: readonly GenerationJob[]): JobGroup[] {
  const byKind = new Map<JobKind, GenerationJob[]>();
  for (const job of jobs) byKind.set(job.kind, [...(byKind.get(job.kind) ?? []), job]);
  return [...byKind.entries()]
    .map(([kind, list]) => ({ kind, latest: list[0]!, earlier: list.slice(1) }))
    .sort((a, b) => JOB_KIND_ORDER.indexOf(a.kind) - JOB_KIND_ORDER.indexOf(b.kind));
}
