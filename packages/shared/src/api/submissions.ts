import { z } from "zod";
import {
  GradingCorrectFix,
  GradingItem,
  GradingOpenGrade,
  GradingTopicUpdate,
} from "../grading/result";
import { QuestionResult, QuizFeedback, SubmissionAnswers } from "../quiz/scoring";

/** The body of `POST /api/quizzes/:quizId/submissions`. The score is computed on the server. */
export const CreateSubmissionInput = z.strictObject({
  answers: SubmissionAnswers,
});
export type CreateSubmissionInput = z.infer<typeof CreateSubmissionInput>;

export const GRADING_STATUSES = ["none", "running", "failed", "done"] as const;
export const GradingStatus = z.enum(GRADING_STATUSES);
export type GradingStatus = z.infer<typeof GradingStatus>;

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
  gradingStatus: GradingStatus,
});
export type SubmissionSummary = z.infer<typeof SubmissionSummary>;

/** The grader's result as the student sees it after submitting (spec section 16 allows it). */
export const SubmissionGradingResult = z.object({
  openGrades: z.array(GradingOpenGrade),
  items: z.array(GradingItem),
  correctFixes: z.array(GradingCorrectFix),
  topicUpdates: z.array(GradingTopicUpdate),
  writeupMd: z.string(),
  /** Sum of the open-question scores. */
  openScore: z.number(),
  /** The automatic score plus `openScore`. */
  totalScore: z.number(),
  /** ISO 8601. */
  gradedAt: z.string(),
});
export type SubmissionGradingResult = z.infer<typeof SubmissionGradingResult>;

export const SubmissionGrading = z.object({
  status: GradingStatus,
  /** The latest grading job's error when `status` is `failed`. */
  error: z.string().nullable(),
  /** Only with `status` `done`. */
  result: SubmissionGradingResult.nullable(),
});
export type SubmissionGrading = z.infer<typeof SubmissionGrading>;

export const SubmissionDetail = SubmissionSummary.extend({
  answers: SubmissionAnswers,
  results: z.array(QuestionResult),
  /** Correct answers, explanations and key points; only ever returned with a submission. */
  feedback: QuizFeedback,
  grading: SubmissionGrading,
});
export type SubmissionDetail = z.infer<typeof SubmissionDetail>;
