import { describe, expect, it } from "vitest";
import { QuizPlan } from "./plan";

const planQuestion = {
  id: "q1",
  type: "mc",
  topic: "Batch obrada",
  angle: "Scenario sa noćnim jobom",
  answer: "Propusnost",
  keyPoints: [],
  mcCorrectIndex: 2,
  mcOptionCount: 4,
  ref: "Batch › Uvod",
  extra: false,
  targetsMisconception: "Batch je uvek sporiji",
  isRepeat: false,
  classNumber: null,
};

const plan = {
  code: "P01",
  title: "Uvod",
  subtitle: "Predavanje 1",
  chips: ["batch"],
  lessonsToRead: ["01"],
  targetMinutes: 20,
  typeMix: { mc: 1, num: 0, match: 0, open: 0 },
  weightingRationale: "Batch je centralna tema.",
  leftOut: [{ topic: "Stream", reason: "Odloženo za sledeće predavanje" }],
  questions: [planQuestion],
};

describe("QuizPlan", () => {
  it("accepts a plan", () => {
    expect(QuizPlan.parse(plan)).toEqual(plan);
  });

  it("accepts non-mc questions with null mc fields", () => {
    const open = {
      ...planQuestion,
      id: "q2",
      type: "open",
      keyPoints: ["a"],
      mcCorrectIndex: null,
      mcOptionCount: null,
      targetsMisconception: null,
    };
    expect(QuizPlan.safeParse({ ...plan, questions: [open] }).success).toBe(true);
  });

  it("rejects a plan without questions or with an unknown type", () => {
    expect(QuizPlan.safeParse({ ...plan, questions: [] }).success).toBe(false);
    expect(
      QuizPlan.safeParse({ ...plan, questions: [{ ...planQuestion, type: "essay" }] }).success,
    ).toBe(false);
  });
});
