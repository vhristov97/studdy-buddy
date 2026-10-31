import type { PipelineEvent } from "@studdy/shared";

/** Domain events of the generate pipeline, emitted and handled through the `Coordinator`. */
export const DOMAIN_EVENTS = {
  /** Payload `GenerateRequestedPayload`: starts the lesson-writer stage. */
  GENERATE_REQUESTED: "class.generate_requested",
  /** Payload `LessonReadyPayload`: the lesson is saved; the quiz and viz branches start here. */
  LESSON_READY: "lesson.ready",
  /** Payload `QuizRequestedPayload`: starts the quiz planner, builder and reviewer for a quiz job. */
  QUIZ_REQUESTED: "quiz.requested",
  /** Payload `QuizReleasedPayload`: the quiz passed review and is in the library. */
  QUIZ_RELEASED: "quiz.released",
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

export interface QuizRequestedPayload {
  classId: number;
  jobId: number;
}

export interface QuizReleasedPayload {
  classId: number;
  quizId: number;
  code: string;
}

export type JobUpdatedPayload = Extract<PipelineEvent, { type: "job" }>;
export type JobProgressPayload = Extract<PipelineEvent, { type: "progress" }>;
