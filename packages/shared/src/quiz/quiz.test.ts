import { describe, expect, it } from "vitest";
import { QUIZ_CODE_PATTERN, Question, Quiz, lessonQuizCode } from "./quiz";
import { validQuiz } from "./fixtures";
import { validateQuiz } from "./validate";

describe("Quiz schema", () => {
  it("accepts a quiz with one question of each type", () => {
    expect(Quiz.parse(validQuiz)).toEqual(validQuiz);
    expect(validateQuiz(validQuiz).errors).toEqual([]);
  });

  it("discriminates questions by type", () => {
    const [mc, num, match, open] = validQuiz.questions;
    for (const q of [mc, num, match, open]) expect(Question.safeParse(q).success).toBe(true);
    expect(Question.safeParse({ ...mc, type: "essay" }).success).toBe(false);
    expect(Question.safeParse({ ...open, keyPoints: [] }).success).toBe(false);
    expect(Question.safeParse({ ...mc, options: ["a"] }).success).toBe(false);
    expect(Question.safeParse({ ...num, tolerance: -1 }).success).toBe(false);
  });

  it("requires nullable fields to be present, not optional", () => {
    const withoutUnit: Record<string, unknown> = { ...validQuiz.questions[1] };
    delete withoutUnit.unit;
    expect(Question.safeParse(withoutUnit).success).toBe(false);
    expect(Question.safeParse({ ...withoutUnit, unit: null }).success).toBe(true);
  });

  it("rejects an empty quiz", () => {
    expect(Quiz.safeParse({ ...validQuiz, questions: [] }).success).toBe(false);
  });
});

describe("quiz codes", () => {
  it("accepts lesson, retake and review codes", () => {
    for (const code of ["P01", "P01R", "P01R2", "K1", "K12"]) {
      expect(QUIZ_CODE_PATTERN.test(code)).toBe(true);
    }
  });

  it("rejects malformed codes", () => {
    for (const code of ["p1", "P1", "Q01", "", "P01X", "K", "k1"]) {
      expect(QUIZ_CODE_PATTERN.test(code)).toBe(false);
    }
  });

  it("builds the lesson quiz code from the class number", () => {
    expect(lessonQuizCode(1)).toBe("P01");
    expect(lessonQuizCode(12)).toBe("P12");
    expect(lessonQuizCode(123)).toBe("P123");
    expect(QUIZ_CODE_PATTERN.test(lessonQuizCode(7))).toBe(true);
  });
});
