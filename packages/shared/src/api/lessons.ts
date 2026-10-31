import { z } from "zod";
import { ClassStatus } from "./courses";

/** What a generation job does. `viz` builds one visualization (one job per selected suggestion). */
export const JOB_KINDS = ["lesson", "quiz", "grading", "viz_topics", "viz"] as const;
export const JobKind = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKind>;

export const JOB_STATUSES = ["running", "succeeded", "failed"] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

/** Topic mastery: unknown, not understood, partly, understood. */
export const TOPIC_RATINGS = ["?", "✗", "~", "✓"] as const;
export const TopicRating = z.enum(TOPIC_RATINGS);
export type TopicRating = z.infer<typeof TopicRating>;

export const TOPIC_EVENT_SOURCES = ["notes", "quiz", "grading"] as const;
export const TopicEventSource = z.enum(TOPIC_EVENT_SOURCES);
export type TopicEventSource = z.infer<typeof TopicEventSource>;

/** `topic_event.outcome` of a misconception found in the student's notes. */
export const MISCONCEPTION_OUTCOME = "misconception";

export const GenerationJob = z.object({
  id: z.number().int(),
  classId: z.number().int(),
  kind: JobKind,
  /** The pipeline stage, e.g. `lesson-writer`. */
  stage: z.string(),
  status: JobStatus,
  /** 1 for the first run, +1 for every retry after a failure. */
  attempt: z.number().int(),
  error: z.string().nullable(),
  /** Review cycle (from 1) of a running or finished `quiz`/`viz` job; null before the first review and for other kinds. */
  cycle: z.number().int().nullable(),
  /** The submission a `grading` job grades; null for other kinds. */
  submissionId: z.number().int().nullable(),
  /** The visualization suggestion a `viz` job builds; null for other kinds. */
  suggestionId: z.number().int().nullable(),
  /**
   * The cumulative quiz code ("K1") a `quiz` job builds; null for lesson quizzes and other kinds.
   * A cumulative job's `classId` is the highest class it covers.
   */
  quizCode: z.string().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
  /** ISO 8601; null while running. */
  finishedAt: z.string().nullable(),
});
export type GenerationJob = z.infer<typeof GenerationJob>;

export const TopicEvent = z.object({
  id: z.number().int(),
  source: TopicEventSource,
  /** E.g. a quiz code. */
  ref: z.string().nullable(),
  outcome: z.string().nullable(),
  misconceptionText: z.string().nullable(),
  correctionText: z.string().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type TopicEvent = z.infer<typeof TopicEvent>;

export const TopicView = z.object({
  id: z.number().int(),
  name: z.string(),
  /** Order in the lesson, from 0. */
  position: z.number().int(),
  rating: TopicRating,
  deferred: z.boolean(),
  deferredNote: z.string().nullable(),
  /** Oldest first. */
  events: z.array(TopicEvent),
});
export type TopicView = z.infer<typeof TopicView>;

export const LessonView = z.object({
  classId: z.number().int(),
  bodyMd: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
  /** In lesson order. */
  topics: z.array(TopicView),
});
export type LessonView = z.infer<typeof LessonView>;

export const ClassJobs = z.object({
  /** Newest first. */
  jobs: z.array(GenerationJob),
});
export type ClassJobs = z.infer<typeof ClassJobs>;

/** Pushed over `GET /api/classes/:classId/events`; the SSE `event:` name is the `type`. */
export const PipelineEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job"), job: GenerationJob, classStatus: ClassStatus }),
  z.object({
    type: z.literal("progress"),
    classId: z.number().int(),
    jobId: z.number().int(),
    stage: z.string(),
    /** Characters of model output received so far. */
    outputChars: z.number().int(),
  }),
]);
export type PipelineEvent = z.infer<typeof PipelineEvent>;
