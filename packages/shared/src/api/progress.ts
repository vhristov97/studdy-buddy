import { z } from "zod";
import { BacklogReason } from "../grading/result";
import { ClassStatus } from "./courses";
import { TopicRating } from "./lessons";
import { GradingStatus } from "./submissions";

export const ProgressBacklogItem = z.object({
  topic: z.string(),
  classNumber: z.number().int(),
  /** The cumulative quiz the topic is mandatory in, e.g. "K1". */
  dueQuiz: z.string(),
  reason: BacklogReason,
  /** ISO 8601. */
  createdAt: z.string(),
});
export type ProgressBacklogItem = z.infer<typeof ProgressBacklogItem>;

export const ProgressTopic = z.object({
  id: z.number().int(),
  classNumber: z.number().int(),
  name: z.string(),
  rating: TopicRating,
  deferred: z.boolean(),
  /** Unique quiz refs from the topic's quiz events, e.g. "P01". */
  testedRefs: z.array(z.string()),
  /** The latest grading note (a rating event's note); null when the topic was never graded. */
  lastNote: z.string().nullable(),
});
export type ProgressTopic = z.infer<typeof ProgressTopic>;

export const ProgressQuizHistoryEntry = z.object({
  quizId: z.number().int(),
  code: z.string(),
  title: z.string(),
  submissionId: z.number().int(),
  /** ISO 8601. */
  submittedAt: z.string(),
  autoScore: z.number(),
  autoMax: z.number().int(),
  /** Null until graded. */
  openScore: z.number().nullable(),
  /** Null until graded. */
  totalScore: z.number().nullable(),
  gradingStatus: GradingStatus,
});
export type ProgressQuizHistoryEntry = z.infer<typeof ProgressQuizHistoryEntry>;

export const ProgressVisualizationEntry = z.object({
  id: z.number().int(),
  title: z.string(),
  classNumber: z.number().int(),
  className: z.string(),
  /** From the visualization's suggestion; null when the suggestion was deleted. */
  concept: z.string().nullable(),
  /** The misconception it targets; null when the suggestion was deleted. */
  misconception: z.string().nullable(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type ProgressVisualizationEntry = z.infer<typeof ProgressVisualizationEntry>;

/** A cumulative review ("K1") that is due: enough classes have a ready lesson and it does not exist yet. */
export const CumulativeDue = z.object({
  code: z.string().regex(/^K\d+$/),
  /** Number of the last class the review covers. */
  coversThrough: z.number().int(),
});
export type CumulativeDue = z.infer<typeof CumulativeDue>;

export const CumulativeScheduleStatus = z.enum([
  "due",
  "building",
  "available",
  "submitted",
  "grading_failed",
  "graded",
]);
export type CumulativeScheduleStatus = z.infer<typeof CumulativeScheduleStatus>;

/** One row of the cumulative test schedule (spec §6): test, coverage, when, result. */
export const CumulativeScheduleEntry = z.object({
  code: z.string(),
  /** Number of the last class the review covers. */
  coversThrough: z.number().int(),
  /**
   * `due`: offered but not built (or its last build failed); `building`: a build job is running;
   * `available`: released, not taken; `submitted`: taken, grading not finished;
   * `grading_failed`: taken, the latest grading failed and there is no result; `graded`: graded.
   */
  status: CumulativeScheduleStatus,
  /** Null while `due` or `building`. */
  quizId: z.number().int().nullable(),
  /** The submission to re-grade; set only while `grading_failed`. */
  submissionId: z.number().int().nullable(),
  /** ISO 8601, of the latest submission; null when there is none. */
  submittedAt: z.string().nullable(),
  /** Of the latest graded submission; null until graded. */
  totalScore: z.number().nullable(),
});
export type CumulativeScheduleEntry = z.infer<typeof CumulativeScheduleEntry>;

/** `GET /api/courses/:courseId/cumulative`. */
export const CumulativeStatus = z.object({
  /** The course's review cadence (a review every N classes); null when it has none. */
  cadence: z.number().int().nullable(),
  /** Classes with a ready lesson. */
  readyClassCount: z.number().int(),
  /** The code of the next review to be built: the smallest `K<n>` without a released quiz. */
  nextCode: z.string().regex(/^K\d+$/),
  /** The earliest missing review the cadence calls for; null when none is due (always null without cadence). */
  due: z
    .object({
      code: z.string().regex(/^K\d+$/),
      coversThrough: z.number().int(),
      /** Numbers of the covered classes (those with a ready lesson). */
      classNumbers: z.array(z.number().int()),
    })
    .nullable(),
  /** Released cumulative quizzes, oldest first. */
  existing: z.array(
    z.object({
      code: z.string(),
      quizId: z.number().int(),
      coversThrough: z.number().int(),
    }),
  ),
});
export type CumulativeStatus = z.infer<typeof CumulativeStatus>;

/** `POST /api/courses/:courseId/cumulative`. Without a code: the due review, else the next free one. */
export const RequestCumulativeBody = z.object({
  code: z
    .string()
    .regex(/^K\d+$/)
    .optional(),
});
export type RequestCumulativeBody = z.infer<typeof RequestCumulativeBody>;

export const ProgressFlags = z.object({
  /** Draft or failed classes with at least one usable class material and no lesson. */
  classesWithoutLesson: z.array(
    z.object({
      classId: z.number().int(),
      number: z.number().int(),
      title: z.string(),
      status: ClassStatus,
    }),
  ),
  /** Submissions without a grading result (running, failed or never started). */
  ungradedSubmissions: z.array(
    z.object({
      submissionId: z.number().int(),
      quizCode: z.string(),
      /** ISO 8601. */
      submittedAt: z.string(),
    }),
  ),
  /** The cumulative review that is due ("K<n> je na redu"); null when none is. */
  cumulativeDue: CumulativeDue.nullable(),
});
export type ProgressFlags = z.infer<typeof ProgressFlags>;

/** `GET /api/courses/:courseId/progress`. */
export const CourseProgress = z.object({
  /** The "Sledeće" list, in order. */
  nextSteps: z.array(z.string()),
  backlog: z.array(ProgressBacklogItem),
  /** All classes' topics, by class number then position. */
  topics: z.array(ProgressTopic),
  /** Newest first. */
  quizHistory: z.array(ProgressQuizHistoryEntry),
  /** The visualization registry, newest first. */
  visualizations: z.array(ProgressVisualizationEntry),
  /** Cross-course, newest first. */
  observations: z.array(z.string()),
  /** The cumulative test schedule, by review number: every released review plus the due one. */
  cumulative: z.array(CumulativeScheduleEntry),
  flags: ProgressFlags,
});
export type CourseProgress = z.infer<typeof CourseProgress>;
