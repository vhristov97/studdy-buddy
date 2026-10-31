import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GradingResult } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  buildGraderInstruction,
  buildGraderMessage,
  gradeSubmission,
  graderSpec,
  gradingResultSchema,
} from "./grader.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import {
  gradingCtxFixture,
  gradingResultFixture,
  answersFixture,
} from "./testing/grading-fixtures.js";

function issuesOf(result: unknown, ctx = gradingCtxFixture()): string {
  const parsed = gradingResultSchema(ctx).safeParse(result);
  return parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("\n");
}

function mutated(fn: (r: GradingResult) => void): GradingResult {
  const result = gradingResultFixture();
  fn(result);
  return result;
}

const itemOf = (r: GradingResult, id: string, row: number | null = null) =>
  r.items.find((i) => i.questionId === id && i.rowIndex === row)!;

const bad: [string, () => GradingResult, string][] = [
  [
    "a missing open grade",
    () => mutated((r) => void (r.openGrades = [])),
    "open question q7 (open_pending) has no grade",
  ],
  ["an open grade out of range", () => mutated((r) => void (r.openGrades[0]!.score = 1.5)), ""],
  [
    "an open grade for a closed question",
    () =>
      mutated((r) => r.openGrades.push({ questionId: "q1", score: 1, right: "a", missing: "b" })),
    "q1 must not be graded",
  ],
  [
    "an open grade for an open question answered Ne znam",
    () =>
      mutated((r) => r.openGrades.push({ questionId: "q8", score: 0, right: "a", missing: "b" })),
    "q8 must not be graded",
  ],
  [
    "a duplicate open grade",
    () => mutated((r) => void r.openGrades.push({ ...r.openGrades[0]! })),
    "q7 is graded more than once",
  ],
  [
    "an unknown question in openGrades",
    () =>
      mutated((r) => r.openGrades.push({ questionId: "q99", score: 1, right: "a", missing: "b" })),
    '"q99" is not a question',
  ],
  [
    "a missing item",
    () => mutated((r) => void (r.items = r.items.filter((i) => i.questionId !== "q4"))),
    "q4 was a miss (wrong, a misconception) and has no item",
  ],
  [
    "a missing item for a Ne znam open question",
    () => mutated((r) => void (r.items = r.items.filter((i) => i.questionId !== "q8"))),
    "q8 is an open question that was not fully answered",
  ],
  [
    "a missing match row item",
    () =>
      mutated(
        (r) => void (r.items = r.items.filter((i) => !(i.questionId === "q5" && i.rowIndex === 2))),
      ),
    "q5 row 2 was a miss",
  ],
  [
    "an item for a correct closed question",
    () =>
      mutated((r) => r.items.push({ ...itemOf(r, "q4"), questionId: "q1", topic: "Batch obrada" })),
    "q1 was answered correctly",
  ],
  [
    "an item for a correct match row",
    () => mutated((r) => r.items.push({ ...itemOf(r, "q5", 1), rowIndex: 0 })),
    "q5 row 0 was answered correctly",
  ],
  [
    "an item for an unknown question",
    () => mutated((r) => r.items.push({ ...itemOf(r, "q4"), questionId: "q99" })),
    '"q99" is not a question',
  ],
  [
    "a duplicate item",
    () => mutated((r) => r.items.push({ ...itemOf(r, "q4") })),
    "q4 has more than one item",
  ],
  [
    "an item for a full-score open answer",
    () =>
      mutated((r) => {
        r.openGrades[0]!.score = 1;
      }),
    "q7 was graded 1",
  ],
  [
    "a match item without rowIndex",
    () => mutated((r) => void (itemOf(r, "q5", 1).rowIndex = null)),
    "q5 is a match question",
  ],
  [
    "a rowIndex on a non-match item",
    () => mutated((r) => void (itemOf(r, "q4").rowIndex = 0)),
    "q4 is not a match question",
  ],
  [
    "a rowIndex on an open item",
    () => mutated((r) => void (itemOf(r, "q7").rowIndex = 0)),
    "q7 row 0 is an open question, so rowIndex must be null",
  ],
  [
    'a "Ne znam" recorded as a misconception',
    () =>
      mutated((r) => {
        const item = itemOf(r, "q3");
        item.classification = "misconception";
        item.misconception = "Misli da stream čeka.";
        item.studentAnswer = "Ne znam";
      }),
    '"Ne znam" is never a misconception',
  ],
  [
    "a gap item that keeps a misconception text",
    () => mutated((r) => void (itemOf(r, "q3").misconception = "Nešto")),
    "misconception must be null",
  ],
  [
    "an unanswered question recorded as a misconception",
    () => mutated((r) => void (itemOf(r, "q6").classification = "misconception")),
    "is never a misconception",
  ],
  [
    'a "?" match row recorded as a misconception',
    () => mutated((r) => void (itemOf(r, "q5", 1).classification = "misconception")),
    'q5 row 1 was answered "Ne znam"',
  ],
  [
    "a wrong answer recorded as a gap",
    () =>
      mutated((r) => {
        const item = itemOf(r, "q2");
        item.classification = "gap";
        item.misconception = null;
      }),
    "A wrong answer is never a mere gap",
  ],
  [
    "a wrong match row recorded as a gap",
    () =>
      mutated((r) => {
        const item = itemOf(r, "q5", 2);
        item.classification = "gap";
        item.misconception = null;
      }),
    "q5 row 2 was answered wrong",
  ],
  [
    "a wrong answer without misconception text",
    () => mutated((r) => void (itemOf(r, "q4").misconception = null)),
    "q4 was answered wrong",
  ],
  [
    "a wrong answer without the student's wording",
    () => mutated((r) => void (itemOf(r, "q2").studentAnswer = null)),
    "q2 was answered wrong",
  ],
  [
    "partial on a closed question",
    () =>
      mutated((r) => {
        itemOf(r, "q2").classification = "partial";
      }),
    "q2 was answered wrong",
  ],
  [
    "partial on an open answer scored 0",
    () =>
      mutated((r) => {
        r.openGrades[0]!.score = 0;
      }),
    '"partial"; that is only for an open answer',
  ],
  [
    "an open misconception without misconception text",
    () =>
      mutated((r) => {
        const item = itemOf(r, "q7");
        item.classification = "misconception";
      }),
    'q7 is classified "misconception"',
  ],
  [
    "an item topic that differs from the question's",
    () => mutated((r) => void (itemOf(r, "q4").topic = "Stream obrada")),
    'q4 is a question on topic "Batch obrada"',
  ],
  [
    "an unknown topic in correctFixes",
    () => mutated((r) => void (r.correctFixes[0]!.topic = "Nepoznata")),
    'correctFixes: topic "Nepoznata" is not a topic of this quiz',
  ],
  [
    "an unknown topic in topicUpdates",
    () => mutated((r) => void (r.topicUpdates[0]!.topic = "Nepoznata")),
    'topicUpdates: topic "Nepoznata"',
  ],
  [
    "a topicUpdates entry with the wrong classNumber",
    () => mutated((r) => void (r.topicUpdates[2]!.classNumber = 2)),
    'topicUpdates: topic "Skladišta podataka" with classNumber 2',
  ],
  [
    "a missing topicUpdates entry",
    () => mutated((r) => void r.topicUpdates.pop()),
    'quiz topic "Skladišta podataka" (classNumber 1) has no entry',
  ],
  [
    "a duplicate topicUpdates entry",
    () => mutated((r) => void r.topicUpdates.push({ ...r.topicUpdates[0]! })),
    "appears more than once",
  ],
  [
    "a wrong dueQuiz",
    () => mutated((r) => void (r.backlogAdd[0]!.dueQuiz = "K2")),
    'dueQuiz must be "K1", not "K2"',
  ],
  [
    "a backlog topic that is not a quiz topic",
    () => mutated((r) => void (r.backlogAdd[0]!.topic = "Nepoznata")),
    'backlogAdd: topic "Nepoznata"',
  ],
  [
    "left_out on a quiz topic",
    () => mutated((r) => void (r.backlogAdd[0]!.reason = "left_out")),
    "reason left_out is only for topics the plan left out",
  ],
  [
    "a left-out topic missing from the backlog",
    () => mutated((r) => void (r.backlogAdd = r.backlogAdd.filter((b) => b.reason !== "left_out"))),
    'the plan left out "Lambda arhitektura"',
  ],
  [
    "a duplicate backlogAdd",
    () => mutated((r) => void r.backlogAdd.push({ ...r.backlogAdd[0]! })),
    "is added more than once",
  ],
  [
    "a backlogResolve for an unknown topic",
    () => mutated((r) => void r.backlogResolve.push({ topic: "Nepoznata", classNumber: 2 })),
    'backlogResolve: topic "Nepoznata"',
  ],
  [
    "a backlogResolve with the right name but another class's number",
    () =>
      mutated((r) => void r.backlogResolve.push({ topic: "Skladišta podataka", classNumber: 2 })),
    'backlogResolve: topic "Skladišta podataka" with classNumber 2',
  ],
  [
    "a topic both added and resolved",
    () => mutated((r) => void r.backlogResolve.push({ topic: "Stream obrada", classNumber: 2 })),
    "both added to and resolved from the backlog",
  ],
  ["empty nextSteps", () => mutated((r) => void (r.nextSteps = [])), ""],
  [
    "a blank write-up",
    () => mutated((r) => void (r.writeupMd = "   ")),
    "writeupMd must not be empty",
  ],
];

describe("buildGraderMessage", () => {
  it("renders the answers and automatic results per question", () => {
    const message = buildGraderMessage(gradingCtxFixture());
    for (const s of [
      "Kurs: Kurs za test",
      "Kviz P02",
      "Šifra sledećeg kumulativnog kviza: K1",
      // mc: the chosen option text, with the correct one marked
      'Odgovor studenta: [0] "Prva opcija ovde"',
      "[1] Druga opcija ovde   <- TAČNO",
      "Pitanje cilja zabludu:",
      "Ponavljanje teme iz ranijeg predavanja.",
      // num
      "Odgovor studenta: 11 ",
      "Tačan odgovor: 12 min (tolerancija 0)",
      // match, per row
      'red 0 (rowIndex 0): "Kafka" -> tačno "Log događaja"; student: [1] "Log događaja" [tačno]',
      '(rowIndex 1): "Spark" -> tačno "Obrada"; student: Ne znam [ne znam]',
      '(rowIndex 2): "HDFS" -> tačno "Skladište"; student: [1] "Log događaja" [NETAČNO]',
      // open
      "Batch skuplja podatke pa ih obradi odjednom.",
      "Odgovor studenta: Ne znam",
      "Odgovor studenta: (bez odgovora)",
      "status: partial, automatski bodovi: 0.33/1, tačnih redova: 1/3",
      "status: open_pending",
      "status: dont_know",
      "status: unanswered",
      "Automatski rezultat zatvorenih pitanja: 1.33 / 6.",
      'Odgovori "Ne znam": q3, q5.r2, q8.',
      // topics, left out, lessons
      "Skladišta podataka (predavanje 1)",
      "Lambda arhitektura (predavanje 2): Odloženo",
      '<lekcija predavanje="1">',
      '<lekcija predavanje="2">',
      "Backlog je prazan.",
      "Nema postojećih zapažanja o studentu.",
      'Lista "Sledeće" je prazna.',
    ]) {
      expect(message).toContain(s);
    }
  });

  it("lists the assessment format, backlog, observations and next steps when present", () => {
    const message = buildGraderMessage(
      gradingCtxFixture({
        course: {
          id: 1,
          name: "K",
          persona: null,
          assessmentFormat: "PZ: 15 pitanja",
          reviewCadence: null,
        },
        backlog: [{ topic: "Neka tema", classNumber: 1, dueQuiz: "K1", reason: "weak" }],
        observations: ["Računanje je slabije"],
        nextSteps: ["Prvo ovo"],
        plan: null,
      }),
    );
    for (const s of [
      "Format ocenjivanja:\nPZ: 15 pitanja",
      "Neka tema (predavanje 01) — obavezno u K1: weak",
      "Računanje je slabije",
      "1. Prvo ovo",
      "Plan kviza nije dostupan.",
    ]) {
      expect(message).toContain(s);
    }
  });

  it("tells same-named backlog topics of different classes apart", () => {
    const message = buildGraderMessage(
      gradingCtxFixture({
        backlog: [{ topic: "Stream obrada", classNumber: 1, dueQuiz: "K1", reason: "gap" }],
      }),
    );
    expect(message).toContain("- Stream obrada (predavanje 01) — obavezno u K1: gap");
    expect(message).not.toContain("Stream obrada (predavanje 02) — obavezno");
  });

  it("renders a whole-question Ne znam on a match question", () => {
    const ctx = gradingCtxFixture();
    ctx.submission.answers = { ...answersFixture(), q5: "?" };
    const message = buildGraderMessage(ctx);
    expect(message).toContain(
      '(rowIndex 0): "Kafka" -> tačno "Log događaja"; student: Ne znam [ne znam]',
    );
  });
});

describe("buildGraderInstruction", () => {
  it("states the grading invariants", () => {
    const text = buildGraderInstruction(null);
    expect(text).toContain("GAP");
    expect(text).toContain("never a misconception");
    expect(text).toContain("never a mere gap");
    expect(text).toContain("Netačno (zabluda)");
    expect(text).toContain("Ne znam (praznina)");
  });

  it("adds the persona line only when a persona is set", () => {
    const without = buildGraderInstruction(null);
    expect(without).not.toContain("You are also");
    const withPersona = buildGraderInstruction("an experienced data engineer");
    expect(withPersona).toContain("You are also an experienced data engineer;");
    expect(withPersona.startsWith(without)).toBe(true);
  });
});

describe("graderSpec", () => {
  it("uses the planner model and a convertible schema", () => {
    const spec = graderSpec(gradingCtxFixture());
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.name).toBe("grader");
    expect(spec.schemaName).toBe("grading_result");
    expect(spec.maxOutputTokens).toBe(32_000);
    expect(spec.timeoutMs).toBe(20 * 60 * 1000);
    expect(spec.repairAttempts).toBe(2);
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("gradingResultSchema", () => {
  it("accepts the valid fixture", () => {
    expect(issuesOf(gradingResultFixture())).toBe("");
  });

  it.each(bad)("rejects %s", (_label, make, expected) => {
    const issues = issuesOf(make());
    expect(issues).not.toBe("");
    expect(issues).toContain(expected);
  });

  it("accepts a misconception or a gap on an open answer that scored 0", () => {
    for (const classification of ["gap", "misconception"] as const) {
      const result = mutated((r) => {
        r.openGrades[0]!.score = 0;
        const item = itemOf(r, "q7");
        item.classification = classification;
        item.misconception = classification === "misconception" ? "Pogrešna tvrdnja." : null;
      });
      expect(issuesOf(result)).toBe("");
    }
  });

  it("accepts a misconception on a partially scored open answer", () => {
    const result = mutated((r) => {
      const item = itemOf(r, "q7");
      item.classification = "misconception";
      item.misconception = "Pogrešna tvrdnja.";
    });
    expect(issuesOf(result)).toBe("");
  });

  it("requires no items when everything is right and the open answer is fully correct", () => {
    const ctx = gradingCtxFixture();
    ctx.submission.answers = {
      q1: 1,
      q2: 2,
      q3: 0,
      q4: 12,
      q5: { "0": 1, "1": 2, "2": 0 },
      q6: 3,
      q7: "Tekst.",
      q8: "Tekst.",
    };
    ctx.submission.results = ctx.submission.results.map((r) =>
      r.type === "open"
        ? { ...r, status: "open_pending" as const }
        : { ...r, status: "correct" as const, score: 1 },
    );
    const result = mutated((r) => {
      r.items = [];
      r.openGrades = [
        { questionId: "q7", score: 1, right: "Sve.", missing: "Ništa." },
        { questionId: "q8", score: 1, right: "Sve.", missing: "Ništa." },
      ];
    });
    expect(issuesOf(result, ctx)).toBe("");
  });

  it("uses the K code of the context for dueQuiz", () => {
    const ctx = gradingCtxFixture({ nextCumulativeCode: "K2" });
    const result = mutated((r) => r.backlogAdd.forEach((b) => void (b.dueQuiz = "K2")));
    expect(issuesOf(result, ctx)).toBe("");
    expect(issuesOf(gradingResultFixture(), ctx)).toContain('dueQuiz must be "K2"');
  });

  it("converts to a structured output schema", () => {
    expect(() => toStructuredOutputSchema(gradingResultSchema(gradingCtxFixture()))).not.toThrow();
  });
});

describe("gradeSubmission with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-grader-test-"));
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

  it("returns the parsed result", async () => {
    queue = [fakeJsonAnswer(gradingResultFixture())];
    await expect(gradeSubmission(gradingCtxFixture())).resolves.toEqual(gradingResultFixture());
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.model).toBe(config.MODEL_PLANNER);
  });

  it.each(bad.map(([label, make]) => [label, make] as const))(
    "repairs %s",
    async (_label, make) => {
      queue = [fakeJsonAnswer(make()), fakeJsonAnswer(gradingResultFixture())];
      await expect(gradeSubmission(gradingCtxFixture())).resolves.toEqual(gradingResultFixture());
      expect(inner.calls).toHaveLength(2);
    },
  );
});
