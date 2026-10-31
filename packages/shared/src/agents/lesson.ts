import { z } from "zod";

/** Something the student's notes get wrong, with the correct statement. */
export const LessonMisconception = z.object({
  /** What the notes wrongly say, close to the student's wording. */
  claim: z.string().min(1).max(1000),
  /** The correct statement. */
  correction: z.string().min(1).max(2000),
});
export type LessonMisconception = z.infer<typeof LessonMisconception>;

export const LessonTopic = z.object({
  /** Short Serbian topic name, unique within the lesson. */
  name: z.string().min(1).max(120),
  misconceptions: z.array(LessonMisconception),
  /** The lecturer only mentioned the topic and promised to cover it later. */
  deferred: z.boolean(),
  /** What was promised and when; null when the topic is not deferred. */
  deferredNote: z.string().max(1000).nullable(),
});
export type LessonTopic = z.infer<typeof LessonTopic>;

/** Output of the lesson-writer agent: the unified lesson note plus its topic list. */
export const LessonDraft = z.object({
  lessonMd: z.string().min(1),
  topics: z.array(LessonTopic).min(1).max(40),
});
export type LessonDraft = z.infer<typeof LessonDraft>;
