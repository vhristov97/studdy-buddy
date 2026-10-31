import { z } from "zod";

/** A released quiz in the library. Questions and answers are not part of it (the player API comes later). */
export const QuizSummary = z.object({
  id: z.number().int(),
  courseId: z.number().int(),
  /** Null for cumulative (K) quizzes. */
  classId: z.number().int().nullable(),
  /** E.g. "P02". */
  code: z.string(),
  title: z.string(),
  subtitle: z.string(),
  chips: z.array(z.string()),
  questionCount: z.number().int(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type QuizSummary = z.infer<typeof QuizSummary>;
