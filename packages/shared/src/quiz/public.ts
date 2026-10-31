import { z } from "zod";
import type { Question } from "./quiz";

/** Fields every public question has. Mirrors `questionBase` in `quiz.ts`, minus anything secret. */
const publicBase = {
  id: z.string().min(1),
  topic: z.string().min(1),
  prompt: z.string().min(1),
  ref: z.string().min(1),
  extra: z.boolean(),
};

export const PublicMcQuestion = z.strictObject({
  ...publicBase,
  type: z.literal("mc"),
  options: z.array(z.string()),
});
export const PublicNumQuestion = z.strictObject({
  ...publicBase,
  type: z.literal("num"),
  /** Shown next to the input; the answer and tolerance are not part of it. */
  unit: z.string().nullable(),
});
export const PublicMatchQuestion = z.strictObject({
  ...publicBase,
  type: z.literal("match"),
  rows: z.array(z.string()),
  choices: z.array(z.string()),
});
export const PublicOpenQuestion = z.strictObject({
  ...publicBase,
  type: z.literal("open"),
});

/** A question as the student sees it before submitting: no answer, explanation, key points or tolerance. */
export const PublicQuestion = z.discriminatedUnion("type", [
  PublicMcQuestion,
  PublicNumQuestion,
  PublicMatchQuestion,
  PublicOpenQuestion,
]);
export type PublicQuestion = z.infer<typeof PublicQuestion>;

export const PublicQuiz = z.strictObject({
  id: z.number().int(),
  courseId: z.number().int(),
  courseName: z.string(),
  /** Null for cumulative (K) quizzes. */
  classId: z.number().int().nullable(),
  code: z.string(),
  title: z.string(),
  subtitle: z.string(),
  chips: z.array(z.string()),
  /** ISO 8601. */
  createdAt: z.string(),
  questions: z.array(PublicQuestion),
});
export type PublicQuiz = z.infer<typeof PublicQuiz>;

/**
 * Builds the public form field by field. It never spreads the source question, so a secret field
 * added to `Question` later cannot leak without someone copying it here on purpose.
 */
export function toPublicQuestion(q: Question): PublicQuestion {
  switch (q.type) {
    case "mc":
      return {
        id: q.id,
        type: "mc",
        topic: q.topic,
        prompt: q.prompt,
        ref: q.ref,
        extra: q.extra,
        options: [...q.options],
      };
    case "num":
      return {
        id: q.id,
        type: "num",
        topic: q.topic,
        prompt: q.prompt,
        ref: q.ref,
        extra: q.extra,
        unit: q.unit,
      };
    case "match":
      return {
        id: q.id,
        type: "match",
        topic: q.topic,
        prompt: q.prompt,
        ref: q.ref,
        extra: q.extra,
        rows: [...q.rows],
        choices: [...q.choices],
      };
    case "open":
      return {
        id: q.id,
        type: "open",
        topic: q.topic,
        prompt: q.prompt,
        ref: q.ref,
        extra: q.extra,
      };
  }
}
