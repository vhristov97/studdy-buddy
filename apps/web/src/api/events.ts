import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ClassDetail, ClassJobs, GenerationJob, PipelineEvent } from "@studdy/shared";
import { invalidateClassAndCourse } from "./hooks";
import { queryKeys } from "./keys";

export interface ClassEvents {
  /** Latest state of every job seen on the stream. */
  jobs: ReadonlyMap<number, GenerationJob>;
  /** Characters of model output so far, per job. */
  progress: ReadonlyMap<number, number>;
}

const NO_JOBS: ReadonlyMap<number, GenerationJob> = new Map();
const NO_PROGRESS: ReadonlyMap<number, number> = new Map();

function parse(event: Event): PipelineEvent | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as PipelineEvent;
  } catch {
    return null;
  }
}

/**
 * Live pipeline state of a class over SSE. The stream is only open while `enabled` (the class is
 * generating or a job is running) or a job seen on it still runs; the server replays every job on
 * (re)connect. A job event that differs from what the query cache holds refetches the class, its
 * course, jobs and lesson.
 * The state is per hook instance: give the caller a `key` when `classId` can change.
 */
export function useClassEvents(classId: number, enabled: boolean): ClassEvents {
  const client = useQueryClient();
  const [state, setState] = useState<ClassEvents>({ jobs: NO_JOBS, progress: NO_PROGRESS });
  // What the stream announced so far; survives reconnects (the server replays jobs on each).
  const seen = useRef(new Map<number, GenerationJob>());
  const lastStatus = useRef<string | null>(null);

  // A job seen running keeps the stream open even if `enabled` lapses first (e.g. the lesson
  // finishes and the class turns `ready` just before the quiz job shows up in a refetch).
  const active = enabled || [...state.jobs.values()].some((job) => job.status === "running");

  useEffect(() => {
    if (!active || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/classes/${classId}/events`);

    const onJob = (event: Event) => {
      const data = parse(event);
      if (data?.type !== "job") return;
      const { job, classStatus } = data;
      const known = seen.current.get(job.id);
      const cachedJob = client
        .getQueryData<ClassJobs["jobs"]>(queryKeys.classJobs(classId))
        ?.find((item) => item.id === job.id);
      const cachedClass = client.getQueryData<ClassDetail>(queryKeys.class(classId));
      const changed =
        (known ? known.status !== job.status : cachedJob?.status !== job.status) ||
        (lastStatus.current ?? cachedClass?.status) !== classStatus;
      seen.current.set(job.id, job);
      lastStatus.current = classStatus;
      setState((current) => ({ ...current, jobs: new Map(seen.current) }));
      if (changed) void invalidateClassAndCourse(client, classId);
    };

    const onProgress = (event: Event) => {
      const data = parse(event);
      if (data?.type !== "progress") return;
      setState((current) => ({
        ...current,
        progress: new Map(current.progress).set(data.jobId, data.outputChars),
      }));
    };

    source.addEventListener("job", onJob);
    source.addEventListener("progress", onProgress);
    return () => {
      source.removeEventListener("job", onJob);
      source.removeEventListener("progress", onProgress);
      source.close();
    };
  }, [classId, active, client]);

  return state;
}
