import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QuizPlan } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  buildQuizPlannerInstruction,
  buildQuizPlannerMessage,
  planQuiz,
  quizPlanSchema,
  quizPlannerSpec,
} from "./quiz-planner.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import { MISCONCEPTION, ctxFixture, planFixture } from "./testing/quiz-fixtures.js";

function issuesOf(plan: unknown, ctx = ctxFixture()): string {
  const result = quizPlanSchema(ctx).safeParse(plan);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

function mutated(fn: (plan: QuizPlan) => void): QuizPlan {
  const plan = planFixture();
  fn(plan);
  return plan;
}

const bad: [string, () => QuizPlan, string][] = [
  ["wrong code", () => mutated((p) => void (p.code = "P09")), 'quiz code must be "P02"'],
  [
    "wrong ids",
    () => mutated((p) => void (p.questions[2]!.id = "q9")),
    "ids must be q1..q8 in order",
  ],
  [
    "unknown topic",
    () => mutated((p) => void (p.questions[1]!.topic = "Nepoznata")),
    '"Batch obrada", "Stream obrada", "Lambda arhitektura", "Skladišta podataka"',
  ],
  [
    "repeat flag on a current topic",
    () => mutated((p) => void (p.questions[1]!.isRepeat = true)),
    "belongs to this class, so isRepeat must be false",
  ],
  [
    "missing repeat flag on an earlier topic",
    () => mutated((p) => void (p.questions[5]!.isRepeat = false)),
    "earlier class, so isRepeat must be true",
  ],
  [
    "mc option count out of range",
    () => mutated((p) => void (p.questions[0]!.mcOptionCount = 6)),
    "mcOptionCount must be an integer from 3 to 5",
  ],
  [
    "mc index out of range",
    () => mutated((p) => void (p.questions[0]!.mcCorrectIndex = 4)),
    "mcCorrectIndex must be an integer from 0",
  ],
  [
    "mc without index",
    () => mutated((p) => void (p.questions[0]!.mcCorrectIndex = null)),
    "mcCorrectIndex must be an integer from 0",
  ],
  [
    "non-mc with mc fields",
    () => mutated((p) => void (p.questions[3]!.mcCorrectIndex = 1)),
    "mcCorrectIndex must be null for a num question",
  ],
  [
    "open with one key point",
    () => mutated((p) => void (p.questions[6]!.keyPoints = ["samo jedna"])),
    "open question needs at least 2 keyPoints",
  ],
  [
    "closed with key points",
    () => mutated((p) => void (p.questions[1]!.keyPoints = ["tačka"])),
    "keyPoints must be empty for a mc question",
  ],
  [
    "typeMix mismatch",
    () => mutated((p) => void (p.typeMix.mc = 5)),
    "typeMix.mc is 5 but the questions contain 4",
  ],
  [
    "deferred topic",
    () => mutated((p) => void (p.questions[1]!.topic = "Lambda arhitektura")),
    "is deferred and must not be tested",
  ],
  [
    "missing misconception coverage",
    () => mutated((p) => void (p.questions[0]!.targetsMisconception = null)),
    'Topic "Batch obrada" has misconceptions from the student\'s notes but no question',
  ],
  [
    "open before closed",
    () =>
      mutated((p) => {
        const [open] = p.questions.splice(6, 1);
        p.questions.splice(2, 0, open!);
        p.questions.forEach((q, i) => void (q.id = `q${i + 1}`));
      }),
    "closed question after an open question",
  ],
  [
    "repeat before a non-repeat closed question",
    () =>
      mutated((p) => {
        const [repeat] = p.questions.splice(5, 1);
        p.questions.splice(1, 0, repeat!);
        p.questions.forEach((q, i) => void (q.id = `q${i + 1}`));
      }),
    "after repeats from earlier classes",
  ],
  [
    "all mc with the same index",
    () =>
      mutated((p) =>
        p.questions.forEach((q) => {
          if (q.type === "mc") q.mcCorrectIndex = 2;
        }),
      ),
    "All 4 mc questions have mcCorrectIndex 2",
  ],
  [
    "mc index used by more than 60%",
    () =>
      mutated((p) => {
        for (const i of [0, 1, 2]) p.questions[i]!.mcCorrectIndex = 1;
      }),
    "more than 60%",
  ],
];

describe("buildQuizPlannerMessage", () => {
  it("includes the lesson, topics, history, misconceptions and earlier topics", () => {
    const message = buildQuizPlannerMessage(ctxFixture());
    for (const s of [
      "Šifra kviza: P02",
      "Predavanje 2: Obrada podataka",
      "<lekcija>",
      "Batch obrada",
      "Stream obrada",
      MISCONCEPTION,
      "Batch optimizuje propusnost, ne latenciju.",
      "ODLOŽENO, ne testirati: Na sledećem času.",
      "Skladišta podataka",
      "(predavanje 1)",
      "Data lake je isto što i data warehouse",
      "Backlog je prazan.",
    ]) {
      expect(message).toContain(s);
    }
  });

  it("includes the assessment format only when set", () => {
    expect(buildQuizPlannerMessage(ctxFixture())).not.toContain("Format ocenjivanja");
    const ctx = ctxFixture();
    ctx.course.assessmentFormat = "PZ: 15 zatvorenih pitanja";
    expect(buildQuizPlannerMessage(ctx)).toContain(
      "Format ocenjivanja:\nPZ: 15 zatvorenih pitanja",
    );
  });

  it("lists backlog and observations when present, and says so when earlier topics are empty", () => {
    const ctx = ctxFixture({
      earlierTopics: [],
      backlog: [{ topic: "Neka tema", dueQuiz: "K1", reason: "izostavljeno" }],
      observations: ["Računanje je slabije"],
    });
    const message = buildQuizPlannerMessage(ctx);
    expect(message).toContain("Neka tema (obavezno u K1): izostavljeno");
    expect(message).toContain("Računanje je slabije");
    expect(message).toContain("Nema slabih tema iz ranijih predavanja");
  });
});

describe("buildQuizPlannerInstruction", () => {
  it("adds the persona line only when a persona is set", () => {
    const without = buildQuizPlannerInstruction(null);
    expect(without).not.toContain("You are also");
    const withPersona = buildQuizPlannerInstruction("an experienced data engineer");
    expect(withPersona).toContain("You are also an experienced data engineer;");
    expect(withPersona.startsWith(without)).toBe(true);
  });
});

describe("quizPlannerSpec", () => {
  it("uses the planner model and a convertible schema", () => {
    const spec = quizPlannerSpec(ctxFixture());
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.name).toBe("quiz-planner");
    expect(spec.schemaName).toBe("quiz_plan");
    expect(spec.maxOutputTokens).toBe(32_000);
    expect(spec.timeoutMs).toBe(20 * 60 * 1000);
    expect(spec.repairAttempts).toBe(2);
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("quizPlanSchema", () => {
  it("accepts the valid fixture", () => {
    expect(issuesOf(planFixture())).toBe("");
  });

  it.each(bad)("rejects %s", (_label, make, expected) => {
    expect(issuesOf(make())).toContain(expected);
  });

  it("does not apply the mc bias check below four mc questions", () => {
    const plan = mutated((p) => {
      p.questions[5]!.type = "num";
      p.questions[5]!.mcCorrectIndex = null;
      p.questions[5]!.mcOptionCount = null;
      p.typeMix = { mc: 3, num: 2, match: 1, open: 2 };
      for (const i of [0, 1, 2]) p.questions[i]!.mcCorrectIndex = 1;
    });
    expect(issuesOf(plan)).toBe("");
  });

  it("does not require misconception coverage for a deferred topic", () => {
    const ctx = ctxFixture();
    ctx.topics[2]!.history = [
      { source: "notes", ref: null, outcome: "misconception", misconception: "X", correction: "Y" },
    ];
    expect(issuesOf(planFixture(), ctx)).toBe("");
  });

  it("converts to a structured output schema", () => {
    expect(() => toStructuredOutputSchema(quizPlanSchema(ctxFixture()))).not.toThrow();
  });
});

describe("planQuiz with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-quizplan-test-"));
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

  it("returns the parsed plan", async () => {
    queue = [fakeJsonAnswer(planFixture())];
    await expect(planQuiz(ctxFixture())).resolves.toEqual(planFixture());
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.model).toBe(config.MODEL_PLANNER);
  });

  it.each(bad.map(([label, make]) => [label, make] as const))(
    "repairs %s",
    async (_label, make) => {
      queue = [fakeJsonAnswer(make()), fakeJsonAnswer(planFixture())];
      await expect(planQuiz(ctxFixture())).resolves.toEqual(planFixture());
      expect(inner.calls).toHaveLength(2);
    },
  );
});
