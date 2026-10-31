import {
  DONT_KNOW,
  type PublicQuestion,
  type PublicQuiz,
  type SubmissionAnswers,
} from "@studdy/shared";
import { formatExact } from "./format";

/** Free-text answer (num: the raw input text, open: the explanation) or "Ne znam". */
export interface TextDraft {
  text: string;
  dontKnow: boolean;
}

/** Row index (as a string) to the chosen choice index or "?". Unanswered rows are absent. */
export type MatchDraft = Record<string, number | typeof DONT_KNOW>;

/** mc: option index or "?"; num/open: TextDraft; match: MatchDraft. */
export type DraftValue = number | typeof DONT_KNOW | TextDraft | MatchDraft;

/** Question id to what the student has entered so far. Empty entries are absent. */
export type QuizDraft = Record<string, DraftValue>;

const DECIMAL = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/;

/** Parses a typed number, accepting a decimal comma. Null when it is not a number. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(/\s+/g, "");
  if (!DECIMAL.test(trimmed)) return null;
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function isTextDraft(v: unknown): v is TextDraft {
  return isRecord(v) && typeof v.text === "string" && typeof v.dontKnow === "boolean";
}

function matchDraft(v: DraftValue | undefined): MatchDraft {
  return typeof v === "object" && !isTextDraft(v) ? v : {};
}

export function getMatchDraft(v: DraftValue | undefined): MatchDraft {
  return matchDraft(v);
}

export function getTextDraft(v: DraftValue | undefined): TextDraft {
  return isTextDraft(v) ? v : { text: "", dontKnow: false };
}

/** Whether the question counts as answered: it has a value or "Ne znam" (match: every row). */
export function isAnswered(q: PublicQuestion, v: DraftValue | undefined): boolean {
  if (v === undefined) return false;
  switch (q.type) {
    case "mc":
      return v === DONT_KNOW || typeof v === "number";
    case "num": {
      const t = getTextDraft(v);
      return t.dontKnow || parseDecimal(t.text) !== null;
    }
    case "open": {
      const t = getTextDraft(v);
      return t.dontKnow || t.text.trim() !== "";
    }
    case "match": {
      const rows = matchDraft(v);
      return q.rows.every((_, i) => Object.hasOwn(rows, String(i)));
    }
  }
}

export function countAnswered(quiz: PublicQuiz, draft: QuizDraft): number {
  return quiz.questions.filter((q) => isAnswered(q, draft[q.id])).length;
}

/** The submission body for the draft. Unanswered questions (and rows) are left out. */
export function buildAnswers(quiz: PublicQuiz, draft: QuizDraft): SubmissionAnswers {
  const answers: SubmissionAnswers = {};
  for (const q of quiz.questions) {
    const v = draft[q.id];
    if (v === undefined) continue;
    switch (q.type) {
      case "mc":
        if (v === DONT_KNOW || typeof v === "number") answers[q.id] = v;
        break;
      case "num": {
        const t = getTextDraft(v);
        const n = parseDecimal(t.text);
        if (t.dontKnow) answers[q.id] = DONT_KNOW;
        else if (n !== null) answers[q.id] = n;
        break;
      }
      case "open": {
        const t = getTextDraft(v);
        if (t.dontKnow) answers[q.id] = DONT_KNOW;
        else if (t.text.trim() !== "") answers[q.id] = t.text.trim();
        break;
      }
      case "match": {
        const rows: MatchDraft = {};
        q.rows.forEach((_, i) => {
          const choice = matchDraft(v)[String(i)];
          if (choice !== undefined) rows[String(i)] = choice;
        });
        if (Object.keys(rows).length > 0) answers[q.id] = rows;
        break;
      }
    }
  }
  return answers;
}

/** The draft form of stored answers, to show a past submission read-only. */
export function draftFromAnswers(quiz: PublicQuiz, answers: SubmissionAnswers): QuizDraft {
  const draft: QuizDraft = {};
  for (const q of quiz.questions) {
    if (!Object.hasOwn(answers, q.id)) continue;
    const v = answers[q.id];
    if (v === undefined) continue;
    switch (q.type) {
      case "mc":
        if (v === DONT_KNOW || typeof v === "number") draft[q.id] = v;
        break;
      case "num":
        if (v === DONT_KNOW) draft[q.id] = { text: "", dontKnow: true };
        else if (typeof v === "number") draft[q.id] = { text: formatExact(v), dontKnow: false };
        break;
      case "open":
        if (v === DONT_KNOW) draft[q.id] = { text: "", dontKnow: true };
        else if (typeof v === "string") draft[q.id] = { text: v, dontKnow: false };
        break;
      case "match":
        if (v === DONT_KNOW) {
          draft[q.id] = Object.fromEntries(q.rows.map((_, i) => [String(i), DONT_KNOW]));
        } else if (isRecord(v)) {
          draft[q.id] = v as MatchDraft;
        }
        break;
    }
  }
  return draft;
}

/** Keeps only the parts of an untrusted stored draft that fit the quiz. */
export function sanitizeDraft(quiz: PublicQuiz, raw: unknown): QuizDraft {
  if (!isRecord(raw)) return {};
  const draft: QuizDraft = {};
  for (const q of quiz.questions) {
    if (!Object.hasOwn(raw, q.id)) continue;
    const v = raw[q.id];
    switch (q.type) {
      case "mc":
        if (v === DONT_KNOW || (Number.isInteger(v) && (v as number) >= 0)) {
          draft[q.id] = v as DraftValue;
        }
        break;
      case "num":
      case "open":
        if (isTextDraft(v) && (v.dontKnow || v.text !== "")) {
          draft[q.id] = { text: v.text, dontKnow: v.dontKnow };
        }
        break;
      case "match":
        if (isRecord(v)) {
          const rows: MatchDraft = {};
          q.rows.forEach((_, i) => {
            const choice = v[String(i)];
            if (choice === DONT_KNOW || (Number.isInteger(choice) && (choice as number) >= 0)) {
              rows[String(i)] = choice as number | typeof DONT_KNOW;
            }
          });
          if (Object.keys(rows).length > 0) draft[q.id] = rows;
        }
        break;
    }
  }
  return draft;
}

// Draft storage. Every access is wrapped: storage can be missing, full or blocked.

export const draftKey = (quizId: number) => `studdy:quiz-draft:${quizId}`;

export function loadDraft(quiz: PublicQuiz): QuizDraft {
  try {
    const stored = localStorage.getItem(draftKey(quiz.id));
    return stored === null ? {} : sanitizeDraft(quiz, JSON.parse(stored));
  } catch {
    return {};
  }
}

/** Writes the draft, or removes the key when it is empty. */
export function saveDraft(quizId: number, draft: QuizDraft): void {
  try {
    if (Object.keys(draft).length === 0) localStorage.removeItem(draftKey(quizId));
    else localStorage.setItem(draftKey(quizId), JSON.stringify(draft));
  } catch {
    // storage unavailable: the page keeps working without autosave
  }
}

export function clearDraft(quizId: number): void {
  try {
    localStorage.removeItem(draftKey(quizId));
  } catch {
    // storage unavailable
  }
}
