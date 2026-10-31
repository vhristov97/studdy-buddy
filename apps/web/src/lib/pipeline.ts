import type { GenerationJob, JobKind } from "@studdy/shared";

/** Stage label per job kind. M7 adds the visualization ones. */
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  lesson: "Objedinjene beleške",
  quiz: "Kviz",
};

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

/** One group per kind, ordered by the id of its latest job. */
export function groupJobs(jobs: readonly GenerationJob[]): JobGroup[] {
  const byKind = new Map<JobKind, GenerationJob[]>();
  for (const job of jobs) byKind.set(job.kind, [...(byKind.get(job.kind) ?? []), job]);
  return [...byKind.entries()]
    .map(([kind, list]) => ({ kind, latest: list[0]!, earlier: list.slice(1) }))
    .sort((a, b) => a.latest.id - b.latest.id);
}
