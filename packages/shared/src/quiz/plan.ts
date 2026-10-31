import { z } from "zod";
import { QuestionType } from "./quiz";

/** Server-only: the plan is hidden from the student and never sent to the web app. */
export const PlanQuestion = z.object({
  id: z.string().min(1),
  type: QuestionType,
  topic: z.string().min(1),
  /** Angle or scenario; for repeats a NEW angle. */
  angle: z.string().min(1),
  /** Correct answer or key fact as text (for `num`: the value and unit). */
  answer: z.string().min(1),
  /** For `open`: points the key must cover; empty otherwise. */
  keyPoints: z.array(z.string().min(1)),
  /** For `mc`: the planned correct option index (the planner varies these); null otherwise. */
  mcCorrectIndex: z.number().int().min(0).nullable(),
  /** For `mc`: the planned number of options; null otherwise. */
  mcOptionCount: z.number().int().min(2).max(6).nullable(),
  ref: z.string().min(1),
  extra: z.boolean(),
  /** Misconception text this question uses as the main distractor. */
  targetsMisconception: z.string().nullable(),
  /** Repeat of an earlier lecture's topic (goes at the end, before open questions). */
  isRepeat: z.boolean(),
  /**
   * For repeats (`isRepeat` true): the number of the class the topic comes from, since topic names
   * are unique only per class. Null for questions about the current class.
   */
  classNumber: z.number().int().min(1).nullable(),
});
export type PlanQuestion = z.infer<typeof PlanQuestion>;

export const QuizPlanLeftOut = z.object({
  topic: z.string().min(1),
  reason: z.string().min(1),
});
export type QuizPlanLeftOut = z.infer<typeof QuizPlanLeftOut>;

export const QuizPlan = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1),
  chips: z.array(z.string().min(1)),
  lessonsToRead: z.array(z.string().min(1)),
  targetMinutes: z.number().int().min(1),
  typeMix: z.object({
    mc: z.number().int().min(0),
    num: z.number().int().min(0),
    match: z.number().int().min(0),
    open: z.number().int().min(0),
  }),
  weightingRationale: z.string().min(1),
  /** Topics that did not fit; they go to the backlog later ("obavezno u K..."). */
  leftOut: z.array(QuizPlanLeftOut),
  questions: z.array(PlanQuestion).min(1),
});
export type QuizPlan = z.infer<typeof QuizPlan>;
