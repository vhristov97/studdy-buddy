import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateQuiz, type QuizReview } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  buildQuizReviewerInstruction,
  buildQuizReviewerMessage,
  quizReviewSchema,
  quizReviewerSpec,
  reviewQuiz,
  type QuizReviewerInput,
} from "./quiz-reviewer.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import { planFixture, quizFixture } from "./testing/quiz-fixtures.js";

const approved: QuizReview = { approved: true, summary: "Sve je u redu.", fixes: [] };
const rejected: QuizReview = {
  approved: false,
  summary: "Jedno pitanje ima dva tačna odgovora.",
  fixes: [{ questionId: "q3", problem: "Dve opcije su tačne.", change: "Zameni opciju 2." }],
};

function reviewInput(): QuizReviewerInput {
  const quiz = quizFixture();
  return {
    plan: planFixture(),
    quiz,
    flags: [{ questionId: "q2", issue: "Plan deluje sumnjivo." }],
    lessonMd: "LEKCIJA-TEKST",
    earlierLessons: [{ classNumber: 1, title: "Skladišta", lessonMd: "RANIJA-LEKCIJA-TEKST" }],
    report: validateQuiz(quiz),
  };
}

function issuesOf(review: unknown): string {
  const result = quizReviewSchema(quizFixture()).safeParse(review);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

const bad: [string, QuizReview, string][] = [
  [
    "approved with fixes",
    { ...approved, fixes: rejected.fixes },
    "approved is true but fixes is not empty",
  ],
  ["not approved without fixes", { ...rejected, fixes: [] }, "must list at least one concrete fix"],
  [
    "an unknown question id",
    { ...rejected, fixes: [{ ...rejected.fixes[0]!, questionId: "q99" }] },
    'unknown question id "q99"',
  ],
];

describe("buildQuizReviewerMessage", () => {
  it("includes plan, quiz, flags, report and lesson", () => {
    const message = buildQuizReviewerMessage(reviewInput());
    for (const s of [
      "Plan kviza (JSON)",
      "mcCorrectIndex",
      "Izgrađeni kviz (JSON)",
      "Objasni zašto batch optimizuje propusnost.",
      "q2: Plan deluje sumnjivo.",
      "Errors (0):",
      "mc correct-answer positions",
      "LEKCIJA-TEKST",
      "RANIJA-LEKCIJA-TEKST",
      '<ranija_lekcija predavanje="1">',
    ]) {
      expect(message).toContain(s);
    }
  });

  it("has no earlier lesson section when there are no earlier lessons", () => {
    expect(buildQuizReviewerMessage({ ...reviewInput(), earlierLessons: [] })).not.toContain(
      "<ranija_lekcija",
    );
  });

  it("says when the builder set no flags", () => {
    expect(buildQuizReviewerMessage({ ...reviewInput(), flags: [] })).toContain(
      "nije postavio zastavice",
    );
  });
});

describe("quizReviewerSpec", () => {
  it("uses the planner model and a convertible schema", () => {
    const spec = quizReviewerSpec(quizFixture());
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.name).toBe("quiz-reviewer");
    expect(spec.schemaName).toBe("quiz_review");
    expect(spec.maxOutputTokens).toBe(16_000);
    expect(spec.timeoutMs).toBe(15 * 60 * 1000);
    expect(spec.instruction).toBe(buildQuizReviewerInstruction());
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("quizReviewSchema", () => {
  it("accepts approval without fixes and rejection with valid fixes", () => {
    expect(issuesOf(approved)).toBe("");
    expect(issuesOf(rejected)).toBe("");
  });

  it.each(bad)("rejects %s", (_label, review, expected) => {
    expect(issuesOf(review)).toContain(expected);
  });
});

describe("reviewQuiz with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-quizreview-test-"));
    inner = new FakeRunner((_input, i) => queue[i] ?? new Error(`unexpected call ${i}`));
    initAgentRuntime({
      cwd: tmpCwd,
      repoRoot: tmpCwd,
      runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });

  beforeEach(() => {
    queue = [];
    inner.calls.length = 0;
  });

  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns an approval and a rejection", async () => {
    queue = [fakeJsonAnswer(approved)];
    await expect(reviewQuiz(reviewInput())).resolves.toEqual(approved);
    expect(inner.calls[0]!.model).toBe(config.MODEL_PLANNER);

    queue = [fakeJsonAnswer(rejected)];
    inner.calls.length = 0;
    await expect(reviewQuiz(reviewInput())).resolves.toEqual(rejected);
  });

  it.each(bad)("repairs %s", async (_label, review) => {
    queue = [fakeJsonAnswer(review), fakeJsonAnswer(rejected)];
    await expect(reviewQuiz(reviewInput())).resolves.toEqual(rejected);
    expect(inner.calls).toHaveLength(2);
  });
});
