import { z } from "zod";
import { Quiz } from "./quiz";

/** Something in the plan the builder thinks is wrong; it keeps the row as planned and says so. */
export const QuizDraftFlag = z.object({
  questionId: z.string().min(1),
  issue: z.string().min(1),
});
export type QuizDraftFlag = z.infer<typeof QuizDraftFlag>;

/** Output of the quiz-builder agent: the quiz plus the plan problems it noticed (spec §7.2). */
export const QuizDraft = z.object({
  quiz: Quiz,
  flags: z.array(QuizDraftFlag),
});
export type QuizDraft = z.infer<typeof QuizDraft>;

/** One fix the reviewer wants from the builder (spec §7.4): question id, what's wrong, the change. */
export const ReviewFix = z.object({
  questionId: z.string().min(1),
  problem: z.string().min(1),
  change: z.string().min(1),
});
export type ReviewFix = z.infer<typeof ReviewFix>;

/** Output of the quiz-reviewer agent. */
export const QuizReview = z.object({
  approved: z.boolean(),
  summary: z.string().min(1),
  fixes: z.array(ReviewFix),
});
export type QuizReview = z.infer<typeof QuizReview>;
