import { describe, expect, it } from "vitest";
import { validQuiz } from "./fixtures";
import { Quiz } from "./quiz";
import {
  QuizFeedback,
  SubmissionAnswers,
  scoreQuiz,
  toFeedback,
  validateAnswers,
  type QuestionResult,
} from "./scoring";

// q1 mc (answer 1 of 3), q2 num (12.5 +- 0.5), q3 match (answer [1,0]), q4 open
const quiz = Quiz.parse(validQuiz);

const resultOf = (answers: SubmissionAnswers, id: string): QuestionResult =>
  scoreQuiz(quiz, answers).results.find((r) => r.id === id)!;

describe("scoreQuiz: mc", () => {
  it("scores correct, wrong, don't know and unanswered", () => {
    expect(resultOf({ q1: 1 }, "q1")).toMatchObject({ status: "correct", score: 1, max: 1 });
    expect(resultOf({ q1: 0 }, "q1")).toMatchObject({ status: "wrong", score: 0 });
    expect(resultOf({ q1: "?" }, "q1")).toMatchObject({ status: "dont_know", score: 0 });
    expect(resultOf({}, "q1")).toMatchObject({ status: "unanswered", score: 0, max: 1 });
  });
});

describe("scoreQuiz: num", () => {
  it("accepts values within tolerance, including the edges", () => {
    expect(resultOf({ q2: 12.5 }, "q2").status).toBe("correct");
    expect(resultOf({ q2: 12 }, "q2").status).toBe("correct");
    expect(resultOf({ q2: 13 }, "q2").status).toBe("correct");
    expect(resultOf({ q2: 13.01 }, "q2").status).toBe("wrong");
    expect(resultOf({ q2: 11.99 }, "q2").status).toBe("wrong");
  });

  it("tolerates floating-point noise at the edge", () => {
    const q = Quiz.parse({
      ...validQuiz,
      questions: [{ ...validQuiz.questions[1]!, answer: 0.3, tolerance: 0 }],
    });
    expect(scoreQuiz(q, { q2: 0.1 + 0.2 }).results[0]!.status).toBe("correct");
    expect(scoreQuiz(q, { q2: 0.31 }).results[0]!.status).toBe("wrong");
  });

  it("handles zero tolerance, don't know and unanswered", () => {
    const q = Quiz.parse({
      ...validQuiz,
      questions: [{ ...validQuiz.questions[1]!, answer: 4, tolerance: 0 }],
    });
    expect(scoreQuiz(q, { q2: 4 }).results[0]!.status).toBe("correct");
    expect(scoreQuiz(q, { q2: 4.0001 }).results[0]!.status).toBe("wrong");
    expect(resultOf({ q2: "?" }, "q2").status).toBe("dont_know");
    expect(resultOf({}, "q2").status).toBe("unanswered");
  });

  it("treats a non-finite value as unanswered", () => {
    expect(resultOf({ q2: Number.NaN }, "q2").status).toBe("unanswered");
    expect(resultOf({ q2: Number.POSITIVE_INFINITY }, "q2").status).toBe("unanswered");
  });
});

describe("scoreQuiz: match", () => {
  it("gives full, partial and no credit", () => {
    expect(resultOf({ q3: { "0": 1, "1": 0 } }, "q3")).toMatchObject({
      status: "correct",
      score: 1,
      correctRows: 2,
      totalRows: 2,
    });
    expect(resultOf({ q3: { "0": 1, "1": 1 } }, "q3")).toMatchObject({
      status: "partial",
      score: 0.5,
      correctRows: 1,
      totalRows: 2,
    });
    expect(resultOf({ q3: { "0": 0, "1": 1 } }, "q3")).toMatchObject({
      status: "wrong",
      score: 0,
      correctRows: 0,
    });
  });

  it("counts per-row don't know as not correct and lists it", () => {
    const score = scoreQuiz(quiz, { q3: { "0": 1, "1": "?" } });
    expect(score.results.find((r) => r.id === "q3")).toMatchObject({
      status: "partial",
      score: 0.5,
      correctRows: 1,
    });
    expect(score.dontKnow).toEqual(["q3.r2"]);

    const none = scoreQuiz(quiz, { q3: { "0": "?", "1": 1 } });
    expect(none.results.find((r) => r.id === "q3")).toMatchObject({ status: "wrong", score: 0 });
    expect(none.dontKnow).toEqual(["q3.r1"]);
  });

  it("is dont_know when every row is ? or the whole value is ?", () => {
    const rows = scoreQuiz(quiz, { q3: { "0": "?", "1": "?" } });
    expect(rows.results.find((r) => r.id === "q3")!.status).toBe("dont_know");
    expect(rows.dontKnow).toEqual(["q3.r1", "q3.r2"]);
    const whole = scoreQuiz(quiz, { q3: "?" });
    expect(whole.results.find((r) => r.id === "q3")!.status).toBe("dont_know");
    expect(whole.dontKnow).toEqual(["q3"]);
  });

  it("scores unset rows as not correct, and an empty object as unanswered", () => {
    expect(resultOf({ q3: { "0": 1 } }, "q3")).toMatchObject({ status: "partial", score: 0.5 });
    expect(resultOf({ q3: {} }, "q3").status).toBe("unanswered");
    expect(resultOf({}, "q3")).toMatchObject({ status: "unanswered", totalRows: 2 });
  });

  it("gives thirds for three rows", () => {
    const q = Quiz.parse({
      ...validQuiz,
      questions: [
        {
          ...validQuiz.questions[2]!,
          rows: ["a", "b", "c"],
          choices: ["x", "y", "z"],
          answer: [0, 1, 2],
        },
      ],
    });
    const r = scoreQuiz(q, { q3: { "0": 0, "1": 0, "2": 0 } });
    expect(r.results[0]!.score).toBeCloseTo(1 / 3);
    expect(r.autoScore).toBe(0.33);
  });
});

describe("scoreQuiz: open and totals", () => {
  it("marks text as pending, ? as don't know, blank or missing as unanswered", () => {
    expect(resultOf({ q4: "Moj odgovor" }, "q4")).toMatchObject({
      status: "open_pending",
      score: 0,
      max: 0,
    });
    expect(resultOf({ q4: "?" }, "q4")).toMatchObject({ status: "dont_know", max: 0 });
    expect(resultOf({ q4: "  \n " }, "q4").status).toBe("unanswered");
    expect(resultOf({ q4: "" }, "q4").status).toBe("unanswered");
    expect(resultOf({}, "q4").status).toBe("unanswered");
  });

  it("totals the closed score, don't-know ids and pending open answers", () => {
    const score = scoreQuiz(quiz, {
      q1: 1,
      q2: "?",
      q3: { "0": 1, "1": 1 },
      q4: "tekst",
    });
    expect(score).toMatchObject({
      autoScore: 1.5,
      autoMax: 3,
      dontKnow: ["q2"],
      openPending: 1,
    });
    expect(score.results.map((r) => r.id)).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("scores an empty submission as zero", () => {
    expect(scoreQuiz(quiz, {})).toMatchObject({
      autoScore: 0,
      autoMax: 3,
      dontKnow: [],
      openPending: 0,
    });
  });

  it("ignores answers of unknown questions", () => {
    expect(scoreQuiz(quiz, { q99: 1 }).autoScore).toBe(0);
  });

  it("rounds the score to two decimals", () => {
    const q = Quiz.parse({
      ...validQuiz,
      questions: [
        {
          ...validQuiz.questions[2]!,
          rows: ["a", "b", "c"],
          choices: ["x", "y", "z"],
          answer: [0, 1, 2],
        },
        { ...validQuiz.questions[0]!, id: "q9" },
      ],
    });
    expect(scoreQuiz(q, { q3: { "0": 0 }, q9: 1 }).autoScore).toBe(1.33);
  });
});

describe("validateAnswers", () => {
  it("accepts well-formed answers", () => {
    expect(
      validateAnswers(quiz, { q1: 2, q2: -3.5, q3: { "0": 1, "1": "?" }, q4: "tekst" }),
    ).toEqual([]);
    expect(validateAnswers(quiz, { q1: "?", q2: "?", q3: "?", q4: "?" })).toEqual([]);
    expect(validateAnswers(quiz, {})).toEqual([]);
  });

  it("rejects unknown question ids", () => {
    expect(validateAnswers(quiz, { q9: 1 })).toEqual(["q9: unknown question"]);
  });

  it("rejects the wrong value type for the question type", () => {
    expect(validateAnswers(quiz, { q1: "text" })).toHaveLength(1);
    expect(validateAnswers(quiz, { q2: "text" })).toHaveLength(1);
    expect(validateAnswers(quiz, { q3: 1 })).toHaveLength(1);
    expect(validateAnswers(quiz, { q4: 1 })).toHaveLength(1);
    expect(validateAnswers(quiz, { q2: Number.NaN })).toHaveLength(1);
  });

  it("rejects mc indexes that are out of range or not integers", () => {
    expect(validateAnswers(quiz, { q1: 3 })).toHaveLength(1);
    expect(validateAnswers(quiz, { q1: -1 })).toHaveLength(1);
    expect(validateAnswers(quiz, { q1: 1.5 })).toHaveLength(1);
  });

  it("rejects bad match row keys and choices", () => {
    expect(validateAnswers(quiz, { q3: { "2": 0 } })).toEqual(["q3: row 2 is out of range"]);
    expect(validateAnswers(quiz, { q3: { x: 0 } })).toEqual(["q3: row x is out of range"]);
    expect(validateAnswers(quiz, { q3: { "01": 0 } })).toHaveLength(1);
    expect(validateAnswers(quiz, { q3: { "0": 2 } })).toEqual([
      "q3: row 0 choice 2 is out of range",
    ]);
    expect(validateAnswers(quiz, { q3: { "0": -1 } })).toHaveLength(1);
    expect(validateAnswers(quiz, { q3: { "0": 0.5 } })).toHaveLength(1);
    expect(validateAnswers(quiz, { q3: { "0": "x" as never } })).toHaveLength(1);
  });

  it("rejects open text over 20000 characters", () => {
    expect(validateAnswers(quiz, { q4: "a".repeat(20000) })).toEqual([]);
    expect(validateAnswers(quiz, { q4: "a".repeat(20001) })).toHaveLength(1);
  });

  it("collects several errors", () => {
    expect(validateAnswers(quiz, { q1: 9, q9: 1 })).toHaveLength(2);
  });
});

describe("SubmissionAnswers schema", () => {
  it("parses the wire format", () => {
    const answers = { q1: 1, q2: "?", q3: { "0": 1, "1": "?" }, q4: "tekst" };
    expect(SubmissionAnswers.parse(answers)).toEqual(answers);
    expect(SubmissionAnswers.safeParse({ q1: null }).success).toBe(false);
    expect(SubmissionAnswers.safeParse({ q1: true }).success).toBe(false);
    expect(SubmissionAnswers.safeParse({ q3: { "0": 0.5 } }).success).toBe(false);
  });
});

describe("toFeedback", () => {
  it("returns the answers, explanations and key points per type", () => {
    const feedback = toFeedback(quiz);
    expect(QuizFeedback.parse(feedback)).toEqual(feedback);
    expect(feedback.questions).toEqual([
      { id: "q1", type: "mc", answer: 1, explanation: "Batch optimizuje propusnost." },
      {
        id: "q2",
        type: "num",
        answer: 12.5,
        tolerance: 0.5,
        unit: "min",
        explanation: "12.5 minuta.",
      },
      { id: "q3", type: "match", answer: [1, 0], explanation: "Kafka je log, Spark obrada." },
      { id: "q4", type: "open", keyPoints: ["Latencija", "Propusnost"] },
    ]);
  });
});
