import { z } from "zod";
import { QUESTION_TYPES, type Question, type Quiz } from "./quiz";

/** "Ne znam": the student declined to answer. Never counted as a wrong answer. */
export const DONT_KNOW = "?" as const;

export const MAX_OPEN_ANSWER_LENGTH = 20000;

export const EMPTY_SUBMISSION_MESSAGE = "Nijedno pitanje nije odgovoreno.";

/**
 * Whether a numeric answer is within tolerance of the key. Zero tolerance means an exact match
 * (students type decimal literals, so no float arithmetic is involved). With a positive tolerance
 * the slack only absorbs the rounding error of the subtraction (52.7 - 52.6 vs 0.1).
 */
function withinTolerance(value: number, answer: number, tolerance: number): boolean {
  if (tolerance === 0) return value === answer;
  const slack = Number.EPSILON * Math.max(Math.abs(value), Math.abs(answer));
  return Math.abs(value - answer) <= tolerance + slack;
}

const DontKnow = z.literal(DONT_KNOW);

/** Index of the chosen option. */
export const McAnswer = z.union([z.number().int(), DontKnow]);
export type McAnswer = z.infer<typeof McAnswer>;

export const NumAnswer = z.union([z.number(), DontKnow]);
export type NumAnswer = z.infer<typeof NumAnswer>;

export const OpenAnswer = z.union([z.string(), DontKnow]);
export type OpenAnswer = z.infer<typeof OpenAnswer>;

/** Row index (as a string, "0", "1", ...) to the chosen choice index or "?"; or "?" for the whole question. */
export const MatchAnswer = z.union([
  z.record(z.string(), z.union([z.number().int(), DontKnow])),
  DontKnow,
]);
export type MatchAnswer = z.infer<typeof MatchAnswer>;

export const AnswerValue = z.union([DontKnow, z.number(), z.string(), MatchAnswer]);
export type AnswerValue = z.infer<typeof AnswerValue>;

/** Question id to answer. A missing key means the question was left unanswered. */
export const SubmissionAnswers = z.record(z.string(), AnswerValue);
export type SubmissionAnswers = z.infer<typeof SubmissionAnswers>;

export const QUESTION_STATUSES = [
  "correct",
  "wrong",
  "partial",
  "dont_know",
  "unanswered",
  "open_pending",
] as const;
export const QuestionStatus = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const QuestionResult = z.object({
  id: z.string(),
  type: z.enum(QUESTION_TYPES),
  status: QuestionStatus,
  /** 0..1 for closed questions (partial credit for match), always 0 for open ones. */
  score: z.number(),
  /** 1 for closed questions, 0 for open ones (graded later). */
  max: z.number(),
  /** Match questions only. */
  correctRows: z.number().int().optional(),
  totalRows: z.number().int().optional(),
});
export type QuestionResult = z.infer<typeof QuestionResult>;

export const QuizScore = z.object({
  autoScore: z.number(),
  /** Number of closed questions. */
  autoMax: z.number().int(),
  results: z.array(QuestionResult),
  /** "q3" for a whole question, "q14.r2" for the second row of a match question. */
  dontKnow: z.array(z.string()),
  /** Open questions answered with text, waiting for grading. */
  openPending: z.number().int(),
});
export type QuizScore = z.infer<typeof QuizScore>;

const ROW_KEY = /^(0|[1-9]\d*)$/;

const isDontKnow = (value: unknown): value is typeof DONT_KNOW => value === DONT_KNOW;

function isMatchRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function scoreMatch(
  q: Extract<Question, { type: "match" }>,
  value: unknown,
  dontKnow: string[],
): QuestionResult {
  const totalRows = q.rows.length;
  const base = { id: q.id, type: q.type, max: 1, totalRows } as const;
  if (isDontKnow(value)) {
    dontKnow.push(q.id);
    return { ...base, status: "dont_know", score: 0, correctRows: 0 };
  }
  if (!isMatchRecord(value)) return { ...base, status: "unanswered", score: 0, correctRows: 0 };

  let answered = 0;
  let unknownRows = 0;
  let correctRows = 0;
  const rowDontKnow: string[] = [];
  q.rows.forEach((_, index) => {
    if (!Object.hasOwn(value, String(index))) return;
    const given = value[String(index)];
    answered += 1;
    if (isDontKnow(given)) {
      unknownRows += 1;
      rowDontKnow.push(`${q.id}.r${index + 1}`);
    } else if (given === q.answer[index]) {
      correctRows += 1;
    }
  });
  if (answered === 0) return { ...base, status: "unanswered", score: 0, correctRows: 0 };
  dontKnow.push(...rowDontKnow);
  if (unknownRows === totalRows) return { ...base, status: "dont_know", score: 0, correctRows: 0 };
  const status = correctRows === totalRows ? "correct" : correctRows > 0 ? "partial" : "wrong";
  return { ...base, status, score: correctRows / totalRows, correctRows };
}

function scoreQuestion(q: Question, value: unknown, dontKnow: string[]): QuestionResult {
  const missing = value === undefined;
  switch (q.type) {
    case "mc": {
      const base = { id: q.id, type: q.type, max: 1 } as const;
      if (isDontKnow(value)) {
        dontKnow.push(q.id);
        return { ...base, status: "dont_know", score: 0 };
      }
      if (missing || typeof value !== "number") return { ...base, status: "unanswered", score: 0 };
      return value === q.answer
        ? { ...base, status: "correct", score: 1 }
        : { ...base, status: "wrong", score: 0 };
    }
    case "num": {
      const base = { id: q.id, type: q.type, max: 1 } as const;
      if (isDontKnow(value)) {
        dontKnow.push(q.id);
        return { ...base, status: "dont_know", score: 0 };
      }
      if (missing || typeof value !== "number" || !Number.isFinite(value)) {
        return { ...base, status: "unanswered", score: 0 };
      }
      return withinTolerance(value, q.answer, q.tolerance)
        ? { ...base, status: "correct", score: 1 }
        : { ...base, status: "wrong", score: 0 };
    }
    case "match":
      return scoreMatch(q, value, dontKnow);
    case "open": {
      const base = { id: q.id, type: q.type, max: 0, score: 0 } as const;
      if (isDontKnow(value)) {
        dontKnow.push(q.id);
        return { ...base, status: "dont_know" };
      }
      if (typeof value === "string" && value.trim() !== "")
        return { ...base, status: "open_pending" };
      return { ...base, status: "unanswered" };
    }
  }
}

/** Scores the closed questions of a quiz. Open answers are only counted; M6 grades them. */
export function scoreQuiz(quiz: Quiz, answers: SubmissionAnswers): QuizScore {
  const dontKnow: string[] = [];
  const results = quiz.questions.map((q) =>
    scoreQuestion(q, Object.hasOwn(answers, q.id) ? answers[q.id] : undefined, dontKnow),
  );
  return {
    autoScore: round2(results.reduce((sum, r) => sum + r.score, 0)),
    autoMax: results.filter((r) => r.max > 0).length,
    results,
    dontKnow,
    openPending: results.filter((r) => r.status === "open_pending").length,
  };
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * True when no question has any value: every question missing, open answers blank, match
 * objects without rows. "?" (Ne znam) counts as an answer.
 */
export function isEmptySubmission(
  quiz: { questions: readonly { id: string }[] },
  answers: SubmissionAnswers,
): boolean {
  return quiz.questions.every((q) => {
    const value = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    if (value === undefined) return true;
    if (isDontKnow(value)) return false;
    if (typeof value === "string") return value.trim() === "";
    if (isMatchRecord(value)) return Object.keys(value).length === 0;
    return false;
  });
}

/** Shape errors of a submission against its quiz (an empty list means it can be scored). */
export function validateAnswers(quiz: Quiz, answers: SubmissionAnswers): string[] {
  const errors: string[] = [];
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  for (const [id, value] of Object.entries(answers)) {
    const q = byId.get(id);
    if (!q) {
      errors.push(`${id}: unknown question`);
      continue;
    }
    if (isDontKnow(value)) continue;
    switch (q.type) {
      case "mc":
        if (!isInt(value)) errors.push(`${id}: expected an option index or "?"`);
        else if (value < 0 || value >= q.options.length) {
          errors.push(`${id}: option ${value} is out of range`);
        }
        break;
      case "num":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`${id}: expected a finite number or "?"`);
        }
        break;
      case "open":
        if (typeof value !== "string") errors.push(`${id}: expected text or "?"`);
        else if (value.length > MAX_OPEN_ANSWER_LENGTH) {
          errors.push(`${id}: answer is longer than ${MAX_OPEN_ANSWER_LENGTH} characters`);
        }
        break;
      case "match":
        if (!isMatchRecord(value)) {
          errors.push(`${id}: expected an object of row to choice, or "?"`);
          break;
        }
        for (const [rowKey, choice] of Object.entries(value)) {
          if (!ROW_KEY.test(rowKey) || Number(rowKey) >= q.rows.length) {
            errors.push(`${id}: row ${rowKey} is out of range`);
          }
          if (isDontKnow(choice)) continue;
          if (!isInt(choice)) errors.push(`${id}: row ${rowKey} needs a choice index or "?"`);
          else if (choice < 0 || choice >= q.choices.length) {
            errors.push(`${id}: row ${rowKey} choice ${choice} is out of range`);
          }
        }
        break;
    }
  }
  return errors;
}

const feedbackBase = { id: z.string() };

export const QuestionFeedback = z.discriminatedUnion("type", [
  z.object({
    ...feedbackBase,
    type: z.literal("mc"),
    answer: z.number().int(),
    explanation: z.string(),
  }),
  z.object({
    ...feedbackBase,
    type: z.literal("num"),
    answer: z.number(),
    tolerance: z.number(),
    unit: z.string().nullable(),
    explanation: z.string(),
  }),
  z.object({
    ...feedbackBase,
    type: z.literal("match"),
    answer: z.array(z.number().int()),
    explanation: z.string(),
  }),
  z.object({
    ...feedbackBase,
    type: z.literal("open"),
    keyPoints: z.array(z.string()),
  }),
]);
export type QuestionFeedback = z.infer<typeof QuestionFeedback>;

export const QuizFeedback = z.object({ questions: z.array(QuestionFeedback) });
export type QuizFeedback = z.infer<typeof QuizFeedback>;

/** The secrets of a quiz (correct answers, explanations, key points); shown only after a submission. */
export function toFeedback(quiz: Quiz): QuizFeedback {
  return {
    questions: quiz.questions.map((q): QuestionFeedback => {
      switch (q.type) {
        case "mc":
          return { id: q.id, type: "mc", answer: q.answer, explanation: q.explanation };
        case "num":
          return {
            id: q.id,
            type: "num",
            answer: q.answer,
            tolerance: q.tolerance,
            unit: q.unit,
            explanation: q.explanation,
          };
        case "match":
          return { id: q.id, type: "match", answer: [...q.answer], explanation: q.explanation };
        case "open":
          return { id: q.id, type: "open", keyPoints: [...q.keyPoints] };
      }
    }),
  };
}
