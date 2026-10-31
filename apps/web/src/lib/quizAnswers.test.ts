import { describe, expect, it } from "vitest";
import type { PublicQuiz } from "@studdy/shared";
import {
  buildAnswers,
  countAnswered,
  draftFromAnswers,
  isAnswered,
  parseDecimal,
  sanitizeDraft,
} from "./quizAnswers";

const base = { topic: "t", prompt: "p", ref: "r", extra: false };
const quiz: PublicQuiz = {
  id: 1,
  courseId: 1,
  courseName: "C",
  classId: 1,
  code: "P01",
  title: "T",
  subtitle: "S",
  chips: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  questions: [
    { ...base, id: "q1", type: "mc", options: ["a", "b"] },
    { ...base, id: "q2", type: "num", unit: null },
    { ...base, id: "q3", type: "match", rows: ["x", "y"], choices: ["1", "2"] },
    { ...base, id: "q4", type: "open" },
  ],
};
const [mc, num, match, open] = quiz.questions as [
  (typeof quiz.questions)[0],
  (typeof quiz.questions)[0],
  (typeof quiz.questions)[0],
  (typeof quiz.questions)[0],
];

describe("parseDecimal", () => {
  it("accepts a decimal point or comma and rejects other text", () => {
    expect(parseDecimal("3,5")).toBe(3.5);
    expect(parseDecimal(" -2.25 ")).toBe(-2.25);
    expect(parseDecimal("1 000")).toBe(1000);
    expect(parseDecimal(",5")).toBe(0.5);
    expect(parseDecimal("12")).toBe(12);
    for (const bad of ["", "abc", "1,2,3", "1e5", "--1", "3 ms"]) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });
});

describe("isAnswered", () => {
  it("needs a value or Ne znam; match needs every row", () => {
    expect(isAnswered(mc, undefined)).toBe(false);
    expect(isAnswered(mc, 0)).toBe(true);
    expect(isAnswered(mc, "?")).toBe(true);
    expect(isAnswered(num, { text: "abc", dontKnow: false })).toBe(false);
    expect(isAnswered(num, { text: "4", dontKnow: false })).toBe(true);
    expect(isAnswered(num, { text: "", dontKnow: true })).toBe(true);
    expect(isAnswered(open, { text: "  ", dontKnow: false })).toBe(false);
    expect(isAnswered(match, { "0": 1 })).toBe(false);
    expect(isAnswered(match, { "0": 1, "1": "?" })).toBe(true);
  });

  it("counts answered questions of a draft", () => {
    expect(countAnswered(quiz, { q1: 0, q4: { text: "x", dontKnow: false } })).toBe(2);
  });
});

describe("buildAnswers", () => {
  it("uses the wire format and leaves out unanswered parts", () => {
    expect(
      buildAnswers(quiz, {
        q1: "?",
        q2: { text: "2,5", dontKnow: false },
        q3: { "1": 0 },
        q4: { text: " hi ", dontKnow: false },
      }),
    ).toEqual({ q1: "?", q2: 2.5, q3: { "1": 0 }, q4: "hi" });
    expect(buildAnswers(quiz, { q2: { text: "abc", dontKnow: false } })).toEqual({});
  });

  it("round-trips through draftFromAnswers", () => {
    const answers = { q1: 1, q2: 2.5, q3: { "0": 1, "1": "?" as const }, q4: "?" as const };
    const draft = draftFromAnswers(quiz, answers);
    expect(draft.q2).toEqual({ text: "2,5", dontKnow: false });
    expect(buildAnswers(quiz, draft)).toEqual(answers);
  });

  it("expands a whole-question Ne znam on a match question", () => {
    expect(draftFromAnswers(quiz, { q3: "?" }).q3).toEqual({ "0": "?", "1": "?" });
  });
});

describe("sanitizeDraft", () => {
  it("keeps only entries that fit the quiz", () => {
    expect(
      sanitizeDraft(quiz, {
        q1: -1,
        q2: { text: "", dontKnow: false },
        q3: { "0": 1, "5": 1, "1": "bad" },
        q4: { text: "ok", dontKnow: false },
        nope: 1,
      }),
    ).toEqual({ q3: { "0": 1 }, q4: { text: "ok", dontKnow: false } });
    expect(sanitizeDraft(quiz, null)).toEqual({});
    expect(sanitizeDraft(quiz, [1])).toEqual({});
  });
});
