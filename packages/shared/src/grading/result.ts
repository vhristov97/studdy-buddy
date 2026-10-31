import { z } from "zod";

/** Rating a graded topic can get; "?" (untested) is never a grading outcome. */
export const GRADED_RATINGS = ["✗", "~", "✓"] as const;
export const GradedRating = z.enum(GRADED_RATINGS);
export type GradedRating = z.infer<typeof GradedRating>;

export const ITEM_CLASSIFICATIONS = ["gap", "misconception", "partial"] as const;
export const ItemClassification = z.enum(ITEM_CLASSIFICATIONS);
export type ItemClassification = z.infer<typeof ItemClassification>;

export const BACKLOG_REASONS = ["weak", "gap", "left_out"] as const;
export const BacklogReason = z.enum(BACKLOG_REASONS);
export type BacklogReason = z.infer<typeof BacklogReason>;

export const GradingOpenGrade = z.object({
  questionId: z.string().min(1),
  /** 0..1, fractional (for example 0.4). */
  score: z.number().min(0).max(1),
  /** What was right in the answer. */
  right: z.string().min(1),
  /** What was missing or wrong: structure, enumerations, the lecturer's examples. */
  missing: z.string().min(1),
});
export type GradingOpenGrade = z.infer<typeof GradingOpenGrade>;

/** One miss: a wrong, partial, "Ne znam" or unanswered question (per row for match questions). */
export const GradingItem = z.object({
  questionId: z.string().min(1),
  /** 0-based match row; null for every other question type. */
  rowIndex: z.number().int().min(0).nullable(),
  topic: z.string().min(1),
  /**
   * "gap": the student did not know ("Ne znam" or unanswered). "misconception": a wrong answer.
   * "partial": an open answer that is incomplete (0 < score < 1).
   */
  classification: ItemClassification,
  /** The student's own wording or choice; null when there was no answer. */
  studentAnswer: z.string().nullable(),
  /** The wrong belief in the student's wording; always null for a gap. */
  misconception: z.string().nullable(),
  /** A guess at why the student believed it, when visible. */
  likelyCause: z.string().nullable(),
  /** The fact that closes the miss. */
  keyFact: z.string().min(1),
});
export type GradingItem = z.infer<typeof GradingItem>;

export const GradingCorrectFix = z.object({
  topic: z.string().min(1),
  /** The notes misconception this submission shows fixed. */
  misconception: z.string().min(1),
});
export type GradingCorrectFix = z.infer<typeof GradingCorrectFix>;

export const GradingTopicUpdate = z.object({
  topic: z.string().min(1),
  classNumber: z.number().int().min(1),
  rating: GradedRating,
  /** Short note for the topic's tracking row. */
  note: z.string().min(1),
});
export type GradingTopicUpdate = z.infer<typeof GradingTopicUpdate>;

export const GradingBacklogAdd = z.object({
  topic: z.string().min(1),
  classNumber: z.number().int().min(1),
  /** The cumulative quiz the topic is mandatory in, e.g. "K1". */
  dueQuiz: z.string().min(1),
  reason: BacklogReason,
});
export type GradingBacklogAdd = z.infer<typeof GradingBacklogAdd>;

export const GradingBacklogResolve = z.object({
  topic: z.string().min(1),
  classNumber: z.number().int().min(1),
});
export type GradingBacklogResolve = z.infer<typeof GradingBacklogResolve>;

/** Output of the grader agent for one submission. */
export const GradingResult = z.object({
  /** The grader's re-check of the automatic score. */
  autoCheck: z.object({
    agrees: z.boolean(),
    /** What differs and why; null when the grader agrees. */
    note: z.string().nullable(),
  }),
  openGrades: z.array(GradingOpenGrade),
  items: z.array(GradingItem),
  correctFixes: z.array(GradingCorrectFix),
  topicUpdates: z.array(GradingTopicUpdate),
  backlogAdd: z.array(GradingBacklogAdd),
  backlogResolve: z.array(GradingBacklogResolve),
  /** New cross-course observations about the student; may be empty. */
  observations: z.array(z.string().min(1)),
  /** The full new "Sledeće" list, ordered. */
  nextSteps: z.array(z.string().min(1)).min(1),
  /** The results write-up in Markdown (spec §9.4). */
  writeupMd: z.string().min(1),
});
export type GradingResult = z.infer<typeof GradingResult>;
