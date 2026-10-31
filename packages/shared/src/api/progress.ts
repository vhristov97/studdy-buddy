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
});
export type ProgressFlags = z.infer<typeof ProgressFlags>;

/** `GET /api/courses/:courseId/progress`. The review schedule comes later. */
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
  flags: ProgressFlags,
});
export type CourseProgress = z.infer<typeof CourseProgress>;
