import type { PipelineEvent } from "@studdy/shared";

/** Domain events of the generate pipeline, emitted and handled through the `Coordinator`. */
export const DOMAIN_EVENTS = {
  /** Payload `GenerateRequestedPayload`: starts the lesson-writer stage. */
  GENERATE_REQUESTED: "class.generate_requested",
  /** Payload `LessonReadyPayload`: the lesson is saved; the quiz and viz branches start here. */
  LESSON_READY: "lesson.ready",
  /** Payload: `PipelineEvent` of type `job`. Feeds the SSE stream. */
  JOB_UPDATED: "job.updated",
  /** Payload: `PipelineEvent` of type `progress`. Feeds the SSE stream. */
  JOB_PROGRESS: "job.progress",
} as const;

export interface GenerateRequestedPayload {
  classId: number;
  jobId: number;
}

export interface LessonReadyPayload {
  classId: number;
  lessonId: number;
}

export type JobUpdatedPayload = Extract<PipelineEvent, { type: "job" }>;
export type JobProgressPayload = Extract<PipelineEvent, { type: "progress" }>;
