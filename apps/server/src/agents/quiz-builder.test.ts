import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InferenceInput } from "@mozaik-ai/core";
import type { QuizDraft } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  buildQuiz,
  buildQuizBuilderInstruction,
  buildQuizBuilderMessage,
  buildQuizFixMessage,
  openQuizBuilderSession,
  quizBuilderSpec,
  quizDraftSchema,
} from "./quiz-builder.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import { planFixture, quizFixture } from "./testing/quiz-fixtures.js";

function draftFixture(): QuizDraft {
  return { quiz: quizFixture(), flags: [] };
}

function mutated(fn: (draft: QuizDraft) => void): QuizDraft {
  const draft = draftFixture();
  fn(draft);
  return draft;
}

function issuesOf(draft: unknown): string {
  const result = quizDraftSchema(planFixture()).safeParse(draft);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

const bad: [string, () => QuizDraft, string][] = [
  [
    "a wrong quiz code",
    () => mutated((d) => void (d.quiz.code = "P09")),
    'quiz.code must be "P02"',
  ],
  [
    "a changed mc answer index",
    () =>
      mutated((d) => {
        const q = d.quiz.questions[0]!;
        if (q.type === "mc") q.answer = 2;
      }),
    "correct option must be at index 1 as planned, not 2",
  ],
  [
    "a changed mc option count",
    () =>
      mutated((d) => {
        const q = d.quiz.questions[0]!;
        if (q.type === "mc") q.options.pop();
      }),
    "the plan fixes 4 options but the question has 3",
  ],
  [
    "reordered ids",
    () =>
      mutated((d) => {
        const [a, b] = [d.quiz.questions[1]!, d.quiz.questions[2]!];
        d.quiz.questions[1] = b;
        d.quiz.questions[2] = a;
      }),
    'has id "q3" but the plan has "q2" there',
  ],
  [
    "a missing question",
    () => mutated((d) => void d.quiz.questions.pop()),
    "has 7 questions but the plan has 8",
  ],
  [
    "a changed type",
    () =>
      mutated((d) => {
        d.quiz.questions[3] = {
          id: "q4",
          type: "open",
          topic: "Batch obrada",
          prompt: "Objasni.",
          ref: "Obrada › Primer",
          extra: false,
          keyPoints: ["a"],
        };
      }),
    'type must be "num" as planned',
  ],
  [
    "a changed topic",
    () => mutated((d) => void (d.quiz.questions[1]!.topic = "Batch obrada")),
    'topic must be "Stream obrada" as planned',
  ],
  [
    "a changed ref",
    () => mutated((d) => void (d.quiz.questions[1]!.ref = "Drugo")),
    'ref must be "Obrada › Primer" as planned',
  ],
  [
    "a changed title",
    () => mutated((d) => void (d.quiz.title = "Drugi naslov")),
    'quiz.title must be "Obrada podataka"',
  ],
  [
    "a changed subtitle",
    () => mutated((d) => void (d.quiz.subtitle = "Drugi podnaslov")),
    'quiz.subtitle must be "Predavanje 2"',
  ],
  [
    "a changed chip",
    () => mutated((d) => void (d.quiz.chips[1] = "9 pitanja")),
    "quiz.chips must be exactly the plan's chips",
  ],
  [
    "reordered chips",
    () => mutated((d) => void d.quiz.chips.reverse()),
    "quiz.chips must be exactly the plan's chips",
  ],
  [
    "an extra chip",
    () => mutated((d) => void d.quiz.chips.push("Dodatno")),
    "quiz.chips must be exactly the plan's chips",
  ],
  [
    "a changed extra flag",
    () => mutated((d) => void (d.quiz.questions[1]!.extra = true)),
    "extra must be false as planned",
  ],
  [
    "a validator error (blank explanation)",
    () =>
      mutated((d) => {
        const q = d.quiz.questions[3]!;
        if (q.type === "num") q.explanation = "   ";
      }),
    "[missing_explanation] q4",
  ],
  [
    "a validator error (match answer out of range)",
    () =>
      mutated((d) => {
        const q = d.quiz.questions[4]!;
        if (q.type === "match") q.answer = [1, 2, 7];
      }),
    "[match_answer_range]",
  ],
  [
    "a flag with an unknown question id",
    () => mutated((d) => void d.flags.push({ questionId: "q99", issue: "nešto" })),
    'unknown question id "q99"',
  ],
];

describe("buildQuizBuilderMessage", () => {
  it("includes the plan, lesson and notes misconceptions", () => {
    const message = buildQuizBuilderMessage({
      plan: planFixture(),
      lessonMd: "LEKCIJA-TEKST",
      notesMisconceptions: [{ topic: "Batch obrada", claim: "ZABLUDA", correction: "ISPRAVKA" }],
      earlierLessons: [{ classNumber: 1, title: "Skladišta", lessonMd: "RANIJA-LEKCIJA-TEKST" }],
    });
    for (const s of [
      '"code": "P02"',
      "mcCorrectIndex",
      "LEKCIJA-TEKST",
      "ZABLUDA",
      "ISPRAVKA",
      "RANIJA-LEKCIJA-TEKST",
      '<ranija_lekcija predavanje="1">',
    ]) {
      expect(message).toContain(s);
    }
  });

  it("has no <lekcija> block for a cumulative review (empty lesson), only the covered lessons", () => {
    const message = buildQuizBuilderMessage({
      plan: planFixture(),
      lessonMd: "",
      notesMisconceptions: [],
      earlierLessons: [{ classNumber: 1, title: "Skladišta", lessonMd: "RANIJA-LEKCIJA-TEKST" }],
    });
    expect(message).not.toContain("<lekcija>");
    expect(message).toContain('<ranija_lekcija predavanje="1">');
    expect(buildQuizBuilderInstruction()).toContain('cumulative review "K<n>"');
  });

  it("has no earlier lesson section when there are no earlier lessons", () => {
    const message = buildQuizBuilderMessage({
      plan: planFixture(),
      lessonMd: "L",
      notesMisconceptions: [],
      earlierLessons: [],
    });
    expect(message).not.toContain("<ranija_lekcija");
  });

  it("says when there are no notes misconceptions", () => {
    const message = buildQuizBuilderMessage({
      plan: planFixture(),
      lessonMd: "L",
      notesMisconceptions: [],
      earlierLessons: [],
    });
    expect(message).toContain("nema zabluda iz beleški");
  });
});

describe("buildQuizFixMessage", () => {
  it("lists the fixes and asks for the complete object", () => {
    const message = buildQuizFixMessage([
      { questionId: "q3", problem: "Dva tačna odgovora", change: "Zameni opciju 2" },
    ]);
    expect(message).toContain("1. q3: Dva tačna odgovora");
    expect(message).toContain("Izmena: Zameni opciju 2");
    expect(message).toContain("KOMPLETAN");
    expect(message).not.toContain("automatske provere");
  });

  it("appends the checker report when it has findings", () => {
    const message = buildQuizFixMessage([{ questionId: "q1", problem: "a", change: "b" }], {
      errors: [],
      warnings: [
        {
          severity: "warning",
          code: "num_missing_unit",
          message: "A num question should have a unit.",
          path: "questions[3].unit",
          questionId: "q4",
        },
      ],
      mcAnswerPositions: [1, 1],
    });
    expect(message).toContain("num_missing_unit");
  });
});

describe("quizBuilderSpec", () => {
  it("uses the builder model and a convertible schema", () => {
    const spec = quizBuilderSpec(planFixture());
    expect(spec.model).toBe(config.MODEL_BUILDER);
    expect(spec.name).toBe("quiz-builder");
    expect(spec.schemaName).toBe("quiz_draft");
    expect(spec.maxOutputTokens).toBe(32_000);
    expect(spec.timeoutMs).toBe(20 * 60 * 1000);
    expect(spec.repairAttempts).toBe(2);
    expect(spec.instruction).toBe(buildQuizBuilderInstruction());
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("quizDraftSchema", () => {
  it("accepts a matching draft, with flags that reference real ids", () => {
    expect(issuesOf(draftFixture())).toBe("");
    expect(
      issuesOf(
        mutated((d) => void d.flags.push({ questionId: "q2", issue: "Plan deluje pogrešno." })),
      ),
    ).toBe("");
  });

  it("does not block on validator warnings", () => {
    const draft = mutated((d) => {
      const q = d.quiz.questions[3]!;
      if (q.type === "num") q.unit = null;
    });
    expect(issuesOf(draft)).toBe("");
  });

  it.each(bad)("rejects %s", (_label, make, expected) => {
    expect(issuesOf(make())).toContain(expected);
  });
});

function transcript(input: InferenceInput): string[] {
  return input.context
    .getItems()
    .filter((i) => i.type === "message")
    .map((i) => {
      const m = i as unknown as { role: string; content: { text: string } };
      return `${m.role}: ${m.content.text}`;
    });
}

describe("quiz builder with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;
  let seen: string[][];

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-quizbuild-test-"));
    inner = new FakeRunner((input, i) => {
      seen.push(transcript(input));
      return queue[i] ?? new Error(`unexpected call ${i}`);
    });
    initAgentRuntime({
      cwd: tmpCwd,
      repoRoot: tmpCwd,
      runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });

  beforeEach(() => {
    queue = [];
    seen = [];
    inner.calls.length = 0;
  });

  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns the parsed draft on the builder model", async () => {
    queue = [fakeJsonAnswer(draftFixture())];
    await expect(buildQuiz(planFixture(), "Lekcija", [], [])).resolves.toEqual(draftFixture());
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.model).toBe(config.MODEL_BUILDER);
  });

  it.each(bad)("repairs %s", async (_label, make) => {
    queue = [fakeJsonAnswer(make()), fakeJsonAnswer(draftFixture())];
    await expect(buildQuiz(planFixture(), "Lekcija", [], [])).resolves.toEqual(draftFixture());
    expect(inner.calls).toHaveLength(2);
  });

  it("keeps the conversation across a build and a fix round in one session", async () => {
    const fixed = draftFixture();
    fixed.quiz.questions[6]!.prompt = "Objasni zašto batch optimizuje propusnost, na primeru.";
    queue = [fakeJsonAnswer(draftFixture()), fakeJsonAnswer(fixed)];

    const session = openQuizBuilderSession(planFixture());
    try {
      const built = await session.send(
        buildQuizBuilderMessage({
          plan: planFixture(),
          lessonMd: "Lekcija",
          notesMisconceptions: [],
          earlierLessons: [],
        }),
      );
      expect(built).toEqual(draftFixture());
      const result = await session.send(
        buildQuizFixMessage([{ questionId: "q7", problem: "Prekratko", change: "Dodaj primer" }]),
      );
      expect(result).toEqual(fixed);
    } finally {
      session.close();
    }

    expect(inner.calls).toHaveLength(2);
    expect(seen[0]).toHaveLength(2);
    expect(seen[1]!.length).toBeGreaterThan(seen[0]!.length);
    expect(seen[1]!.slice(0, 2)).toEqual(seen[0]);
    expect(seen[1]!.join("\n")).toContain("Dodaj primer");
    expect(seen[1]!.join("\n")).toContain("Lekcija");
  });
});
