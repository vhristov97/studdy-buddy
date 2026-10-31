import { z } from "zod";
import { QuestionResult, QuizFeedback, SubmissionAnswers } from "../quiz/scoring";

/** The body of `POST /api/quizzes/:quizId/submissions`. The score is computed on the server. */
export const CreateSubmissionInput = z.strictObject({
  answers: SubmissionAnswers,
});
export type CreateSubmissionInput = z.infer<typeof CreateSubmissionInput>;

export const SubmissionSummary = z.object({
  id: z.number().int(),
  quizId: z.number().int(),
  autoScore: z.number(),
  autoMax: z.number().int(),
  openPending: z.number().int(),
  /** "q3" or "q14.r2" ids. */
  dontKnow: z.array(z.string()),
  /** ISO 8601. */
  submittedAt: z.string(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummary>;

export const SubmissionDetail = SubmissionSummary.extend({
  answers: SubmissionAnswers,
  results: z.array(QuestionResult),
  /** Correct answers, explanations and key points; only ever returned with a submission. */
  feedback: QuizFeedback,
});
export type SubmissionDetail = z.infer<typeof SubmissionDetail>;
