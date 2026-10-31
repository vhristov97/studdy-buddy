import { z } from "zod";

export const QUESTION_TYPES = ["mc", "num", "match", "open"] as const;
export const QuestionType = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionType>;

/** `P01`, `P01R`, `P01R2` (lesson quizzes and their retakes) or `K1` (cumulative reviews). */
export const QUIZ_CODE_PATTERN = /^(P\d{2}R?\d*|K\d+)$/;

/** The lesson quiz code for a class number: 1 -> "P01". */
export function lessonQuizCode(classNumber: number): string {
  return `P${String(classNumber).padStart(2, "0")}`;
}

const questionBase = {
  /** "q1", "q2", ... unique within the quiz. */
  id: z.string().min(1),
  /** A topic name from the lesson's tracking table. */
  topic: z.string().min(1),
  /** Markdown allowed. */
  prompt: z.string().min(1),
  /** Slide-section reference, e.g. "Inkrementalne arhitekture › Problem 2"; lecturer-only content is marked "(predavač)". */
  ref: z.string().min(1),
  /** The content came from the tutor's (D) additions rather than the slides. */
  extra: z.boolean(),
};

export const McQuestion = z.object({
  ...questionBase,
  type: z.literal("mc"),
  options: z.array(z.string().min(1)).min(2).max(6),
  /** Index of the correct option. */
  answer: z.number().int().min(0),
  explanation: z.string().min(1),
});
export type McQuestion = z.infer<typeof McQuestion>;

export const NumQuestion = z.object({
  ...questionBase,
  type: z.literal("num"),
  answer: z.number(),
  tolerance: z.number().min(0),
  unit: z.string().nullable(),
  explanation: z.string().min(1),
});
export type NumQuestion = z.infer<typeof NumQuestion>;

export const MatchQuestion = z.object({
  ...questionBase,
  type: z.literal("match"),
  rows: z.array(z.string().min(1)).min(2),
  choices: z.array(z.string().min(1)).min(2),
  /** One choice index per row. */
  answer: z.array(z.number().int().min(0)),
  explanation: z.string().min(1),
});
export type MatchQuestion = z.infer<typeof MatchQuestion>;

export const OpenQuestion = z.object({
  ...questionBase,
  type: z.literal("open"),
  /** Everything a complete oral answer names. */
  keyPoints: z.array(z.string().min(1)).min(1),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const Question = z.discriminatedUnion("type", [
  McQuestion,
  NumQuestion,
  MatchQuestion,
  OpenQuestion,
]);
export type Question = z.infer<typeof Question>;

export const Quiz = z.object({
  /** "P01", "K1", "P01R". */
  code: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1),
  chips: z.array(z.string().min(1)),
  questions: z.array(Question).min(1),
});
export type Quiz = z.infer<typeof Quiz>;
