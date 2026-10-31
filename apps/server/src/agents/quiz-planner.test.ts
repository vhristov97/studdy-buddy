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
import {
  MISCONCEPTION,
  ctxFixture,
  cumulativeCtxFixture,
  cumulativePlanFixture,
  planFixture,
} from "./testing/quiz-fixtures.js";

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
    "is not one of the earlier topics",
  ],
  [
    "missing repeat flag on an earlier topic",
    () => mutated((p) => void (p.questions[5]!.isRepeat = false)),
    "earlier class, so isRepeat must be true",
  ],
  [
    "repeat without classNumber",
    () => mutated((p) => void (p.questions[5]!.classNumber = null)),
    'q6: a repeat must set classNumber to the class the topic "Skladišta podataka" comes from. Valid (topic, class) pairs: ("Skladišta podataka", predavanje 1)',
  ],
  [
    "repeat with the wrong classNumber",
    () => mutated((p) => void (p.questions[5]!.classNumber = 3)),
    'topic "Skladišta podataka" is not an earlier topic of predavanje 3. Valid (topic, class) pairs: ("Skladišta podataka", predavanje 1)',
  ],
  [
    "a repeat whose ref names another class than classNumber",
    () => mutated((p) => void (p.questions[5]!.ref = "Predavanje 3 › Skladišta podataka")),
    'q6: a repeat\'s ref must start with "Predavanje 1 ›"',
  ],
  [
    "a repeat whose ref has no class prefix",
    () => mutated((p) => void (p.questions[5]!.ref = "Skladišta podataka")),
    'a repeat\'s ref must start with "Predavanje 1 ›"',
  ],
  [
    "a repeat whose ref names class 10 for classNumber 1",
    () => mutated((p) => void (p.questions[5]!.ref = "Predavanje 10 › Skladišta")),
    'a repeat\'s ref must start with "Predavanje 1 ›"',
  ],
  [
    "a non-repeat with a Predavanje ref",
    () => mutated((p) => void (p.questions[1]!.ref = "Predavanje 1 › Stream obrada")),
    'q2: ref "Predavanje 1 › Stream obrada" starts with "Predavanje <N> ›"',
  ],
  [
    "classNumber on a non-repeat",
    () => mutated((p) => void (p.questions[1]!.classNumber = 1)),
    "classNumber must be null when isRepeat is false",
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
    `Topic "Batch obrada" has misconceptions from the student's notes that no question targets: "${MISCONCEPTION}"`,
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

  it("includes the earlier lessons for the repeat candidates", () => {
    const message = buildQuizPlannerMessage(ctxFixture());
    expect(message).toContain('<ranija_lekcija predavanje="1">');
    expect(message).toContain("Lake čuva sirove podatke, warehouse strukturirane.");
    expect(
      buildQuizPlannerMessage(ctxFixture({ earlierTopics: [], earlierLessons: [] })),
    ).not.toContain("<ranija_lekcija");
  });

  it("lists the notes misconceptions per topic as exact texts", () => {
    const ctx = ctxFixture();
    ctx.topics[1]!.history = [
      {
        source: "notes",
        ref: null,
        outcome: null,
        misconception: "Druga  zabluda",
        correction: null,
      },
    ];
    ctx.topics[0]!.history.push({
      source: "notes",
      ref: null,
      outcome: null,
      misconception: "Treća zabluda",
      correction: null,
    });
    const message = buildQuizPlannerMessage(ctx);
    expect(message).toContain(
      `Tema "Batch obrada":\n  1. ${JSON.stringify(MISCONCEPTION)}\n  2. "Treća zabluda"`,
    );
    expect(message).toContain('Tema "Stream obrada":\n  1. "Druga  zabluda"');
    // Deferred topics are not listed.
    ctx.topics[2]!.history = [
      { source: "notes", ref: null, outcome: null, misconception: "Odložena", correction: null },
    ];
    expect(buildQuizPlannerMessage(ctx)).not.toContain('Tema "Lambda arhitektura":');
  });

  it("includes the assessment format only when set", () => {
    expect(buildQuizPlannerMessage(ctxFixture())).not.toContain("Format ocenjivanja");
    const ctx = ctxFixture();
    ctx.course.assessmentFormat = "PZ: 15 zatvorenih pitanja";
    expect(buildQuizPlannerMessage(ctx)).toContain(
      "Format ocenjivanja:\nPZ: 15 zatvorenih pitanja",
    );
  });

  it("marks deferred backlog items as not to be tested", () => {
    const message = buildQuizPlannerMessage(
      ctxFixture({
        backlog: [
          { topic: "Odložena", classNumber: 1, dueQuiz: "K1", reason: "left_out", deferred: true },
        ],
      }),
    );
    expect(message).toContain("(odloženo — ne testirati dok se ne obradi)");
    expect(message).not.toContain("obavezno u K1");
  });

  it("lists backlog and observations when present, and says so when earlier topics are empty", () => {
    const ctx = ctxFixture({
      earlierTopics: [],
      backlog: [{ topic: "Neka tema", classNumber: 1, dueQuiz: "K1", reason: "izostavljeno" }],
      observations: ["Računanje je slabije"],
    });
    const message = buildQuizPlannerMessage(ctx);
    expect(message).toContain("Neka tema (predavanje 01) — obavezno u K1: izostavljeno");
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

  it("accepts a repeat ref with or without a leading zero on the class number", () => {
    for (const ref of ["Predavanje 1 › Skladišta", "Predavanje 01 › Skladišta"]) {
      expect(issuesOf(mutated((p) => void (p.questions[5]!.ref = ref)))).toBe("");
    }
  });

  it("rejects a repeat of a deferred backlog item and says why", () => {
    const ctx = ctxFixture({
      backlog: [
        { topic: "Odložena", classNumber: 1, dueQuiz: "K1", reason: "left_out", deferred: true },
      ],
    });
    const plan = mutated((p) => {
      p.questions[5]!.topic = "Odložena";
    });
    expect(issuesOf(plan, ctx)).toContain('topic "Odložena" is a deferred backlog item');
  });

  it("does not require misconception coverage for a deferred topic", () => {
    const ctx = ctxFixture();
    ctx.topics[2]!.history = [
      { source: "notes", ref: null, outcome: "misconception", misconception: "X", correction: "Y" },
    ];
    expect(issuesOf(planFixture(), ctx)).toBe("");
  });

  describe("a topic name shared by this class and an earlier one", () => {
    const sharedCtx = () => {
      const ctx = ctxFixture();
      ctx.earlierTopics.push({ ...ctx.earlierTopics[0]!, name: "Stream obrada" });
      return ctx;
    };

    it("accepts it both as a current question and as a repeat", () => {
      const plan = mutated((p) => {
        // q6 becomes a repeat of the earlier "Stream obrada"; q2 stays a current question.
        p.questions[5]!.topic = "Stream obrada";
      });
      expect(issuesOf(plan, sharedCtx())).toBe("");
    });

    it("tells repeats of two earlier classes with the same topic name apart by classNumber", () => {
      const ctx = sharedCtx();
      ctx.earlierTopics.push({ ...ctx.earlierTopics[0]!, classNumber: 3 });
      const plan = (n: number) =>
        mutated((p) => {
          p.questions[5]!.classNumber = n;
          p.questions[5]!.ref = `Predavanje ${n} › Skladišta podataka`;
        });
      expect(issuesOf(plan(1), ctx)).toBe("");
      expect(issuesOf(plan(3), ctx)).toBe("");
      const wrong = issuesOf(plan(2), ctx);
      expect(wrong).toContain("is not an earlier topic of predavanje 2");
      expect(wrong).toContain('("Skladišta podataka", predavanje 3)');
    });

    it("still rejects isRepeat true on a name that is only a current topic", () => {
      const plan = mutated((p) => void (p.questions[1]!.isRepeat = true));
      expect(issuesOf(plan)).toContain("is not one of the earlier topics");
    });

    it("still rejects isRepeat false on a name that is only an earlier topic", () => {
      const plan = mutated((p) => void (p.questions[5]!.isRepeat = false));
      expect(issuesOf(plan, sharedCtx())).toContain("earlier class, so isRepeat must be true");
    });
  });

  describe("misconception coverage", () => {
    const SECOND = "Stream je uvek skuplji od batch obrade";
    const twoCtx = () => {
      const ctx = ctxFixture();
      ctx.topics[0]!.history.push({
        source: "notes",
        ref: null,
        outcome: "misconception",
        misconception: SECOND,
        correction: "Zavisi od opterećenja.",
      });
      return ctx;
    };

    it("rejects a plan that targets only one of two misconceptions of a topic", () => {
      const issues = issuesOf(planFixture(), twoCtx());
      expect(issues).toContain(`"${SECOND}"`);
      expect(issues).not.toContain(JSON.stringify(MISCONCEPTION));
      expect(issues).toContain("copied exactly");
    });

    it("accepts a plan that targets both", () => {
      const plan = mutated((p) => {
        p.questions[1]!.topic = "Batch obrada";
        p.questions[1]!.targetsMisconception = SECOND;
      });
      expect(issuesOf(plan, twoCtx())).toBe("");
    });

    it("compares after trimming, collapsing whitespace and case-folding", () => {
      const plan = mutated((p) => {
        p.questions[0]!.targetsMisconception = `  ${MISCONCEPTION.toUpperCase().replace(/ /g, "  ")} `;
        p.questions[1]!.topic = "Batch obrada";
        p.questions[1]!.targetsMisconception = SECOND.toLowerCase();
      });
      expect(issuesOf(plan, twoCtx())).toBe("");
    });

    it("rejects a matching target on a different topic", () => {
      const plan = mutated((p) => {
        p.questions[0]!.targetsMisconception = null;
        p.questions[1]!.targetsMisconception = MISCONCEPTION; // q2 is on "Stream obrada"
      });
      const issues = issuesOf(plan);
      expect(issues).toContain(`Topic "Batch obrada"`);
      expect(issues).toContain(JSON.stringify(MISCONCEPTION));
      expect(issues).toContain("on that topic");
    });

    it("rejects a matching target on a repeat that shares the topic's name", () => {
      const ctx = ctxFixture();
      ctx.earlierTopics.push({ ...ctx.earlierTopics[0]!, name: "Batch obrada" });
      const plan = mutated((p) => {
        p.questions[0]!.targetsMisconception = null;
        p.questions[5]!.topic = "Batch obrada"; // q6 is a repeat
        p.questions[5]!.targetsMisconception = MISCONCEPTION;
      });
      const issues = issuesOf(plan, ctx);
      expect(issues).toContain(`Topic "Batch obrada"`);
      expect(issues).toContain(JSON.stringify(MISCONCEPTION));
    });

    it("accepts a matching target on the right topic", () => {
      expect(issuesOf(planFixture())).toBe("");
    });

    it("does not count an open question as coverage and rejects the target on it", () => {
      const plan = mutated((p) => {
        p.questions[0]!.targetsMisconception = null;
        p.questions[6]!.topic = "Batch obrada"; // q7 is open
        p.questions[6]!.targetsMisconception = MISCONCEPTION;
      });
      const issues = issuesOf(plan);
      expect(issues).toContain("open questions have no distractors");
      expect(issues).toContain(`Topic "Batch obrada"`);
      expect(issues).toContain(JSON.stringify(MISCONCEPTION));
    });

    it("does not count a num question as coverage", () => {
      const plan = mutated((p) => {
        p.questions[0]!.targetsMisconception = null;
        p.questions[3]!.topic = "Batch obrada"; // q4 is num
        p.questions[3]!.targetsMisconception = MISCONCEPTION;
      });
      expect(issuesOf(plan)).toContain(`Topic "Batch obrada"`);
    });

    it("accepts an mc question on the right topic as coverage", () => {
      const plan = mutated((p) => {
        p.questions[0]!.targetsMisconception = null;
        p.questions[1]!.topic = "Batch obrada"; // q2 is mc
        p.questions[1]!.targetsMisconception = MISCONCEPTION;
      });
      expect(issuesOf(plan)).toBe("");
    });

    it("does not accept a targeted text that matches no misconception", () => {
      const plan = mutated((p) => void (p.questions[0]!.targetsMisconception = "Nešto drugo"));
      expect(issuesOf(plan)).toContain(JSON.stringify(MISCONCEPTION));
    });
  });

  it("converts to a structured output schema", () => {
    expect(() => toStructuredOutputSchema(quizPlanSchema(ctxFixture()))).not.toThrow();
  });
});

describe("cumulative review (K) planning", () => {
  const kIssues = (plan: unknown, ctx = cumulativeCtxFixture()) => issuesOf(plan, ctx);
  const kMutated = (fn: (plan: QuizPlan) => void): QuizPlan => {
    const plan = cumulativePlanFixture();
    fn(plan);
    return plan;
  };
  const dueItem = (topic: string, classNumber: number, extra = {}) => ({
    topic,
    classNumber,
    dueQuiz: "K1",
    reason: "weak" as const,
    ...extra,
  });

  it("accepts the valid fixture", () => {
    expect(kIssues(cumulativePlanFixture())).toBe("");
  });

  it("uses the cumulative instruction and the persona", () => {
    const instruction = buildQuizPlannerInstruction("iskusni inženjer", "cumulative");
    expect(instruction).toContain("cumulative review quiz");
    expect(instruction).toContain("EVERY backlog item that is due");
    expect(instruction).toContain("iskusni inženjer");
    expect(buildQuizPlannerInstruction(null, "cumulative")).not.toContain("also");
    expect(quizPlannerSpec(cumulativeCtxFixture()).instruction).toContain("cumulative review");
    expect(quizPlannerSpec(ctxFixture()).instruction).not.toContain("cumulative review quiz");
  });

  it("rejects a row that is not a repeat", () => {
    expect(kIssues(kMutated((p) => void (p.questions[1]!.isRepeat = false)))).toContain(
      "every question of a cumulative review is a repeat",
    );
  });

  it("rejects a missing or wrong classNumber", () => {
    expect(kIssues(kMutated((p) => void (p.questions[1]!.classNumber = null)))).toContain(
      "classNumber must be set",
    );
    expect(kIssues(kMutated((p) => void (p.questions[1]!.classNumber = 1)))).toContain(
      'topic "Stream obrada" is not a topic of predavanje 1',
    );
  });

  it("rejects a ref that does not match the classNumber", () => {
    expect(
      kIssues(kMutated((p) => void (p.questions[0]!.ref = "Predavanje 1 › Odeljak"))),
    ).toContain('ref must start with "Predavanje 2 ›"');
    expect(kIssues(kMutated((p) => void (p.questions[0]!.ref = "Obrada › Primer")))).toContain(
      'ref must start with "Predavanje 2 ›"',
    );
  });

  it("rejects an unknown topic and a deferred one", () => {
    expect(kIssues(kMutated((p) => void (p.questions[1]!.topic = "Nepoznata")))).toContain(
      "not a known topic of the covered classes",
    );
    const ctx = cumulativeCtxFixture({
      backlog: [dueItem("Lambda arhitektura", 2, { deferred: true })],
    });
    expect(
      kIssues(
        kMutated((p) => void (p.questions[1]!.topic = "Lambda arhitektura")),
        ctx,
      ),
    ).toContain("is deferred");
  });

  it("requires a question for every due, not deferred backlog item", () => {
    const ctx = cumulativeCtxFixture({
      backlog: [
        dueItem("Skladišta podataka", 1),
        dueItem("Batch obrada", 2, { dueQuiz: "K2" }), // due later: not required
        dueItem("Lambda arhitektura", 2, { deferred: true }), // deferred: not required
      ],
    });
    expect(kIssues(cumulativePlanFixture(), ctx)).toBe("");
    // Covering it on the other class's topic of the same name does not count.
    const missing = kMutated((p) => {
      p.questions[5]!.topic = "Batch obrada";
      p.questions[5]!.classNumber = 2;
      p.questions[5]!.ref = "Predavanje 2 › Odeljak";
    });
    expect(kIssues(missing, ctx)).toContain(
      'Backlog items due in K1 have no question: "Skladišta podataka" (predavanje 1)',
    );
  });

  it("does not demand note misconceptions or lesson-quiz ordering", () => {
    // closed questions of different classes in any order; open questions still last
    const reordered = kMutated((p) => {
      p.questions[0]!.classNumber = 1;
      p.questions[0]!.topic = "Skladišta podataka";
      p.questions[0]!.ref = "Predavanje 1 › Odeljak";
    });
    expect(kIssues(reordered)).toBe("");
    expect(
      kIssues(
        kMutated((p) => {
          const [first, second] = [p.questions[0]!, p.questions[6]!];
          p.questions[0] = { ...second, id: "q1" };
          p.questions[6] = { ...first, id: "q7" };
        }),
      ),
    ).toContain("closed question after an open question");
  });

  it("still checks the code, the typeMix and the mc positions", () => {
    expect(kIssues(kMutated((p) => void (p.code = "K9")))).toContain('quiz code must be "K1"');
    expect(kIssues(kMutated((p) => void (p.typeMix.mc = 9)))).toContain("typeMix.mc is 9");
  });

  it("builds a message from the lessons, topics, due backlog and observations", () => {
    const ctx = cumulativeCtxFixture({
      backlog: [
        dueItem("Skladišta podataka", 1),
        dueItem("Batch obrada", 2, { dueQuiz: "K2" }),
        dueItem("Lambda arhitektura", 2, { deferred: true }),
      ],
      observations: ["Računanje je slabije."],
    });
    const message = buildQuizPlannerMessage(ctx);
    expect(message).toContain("Kumulativni pregled K1");
    expect(message).toContain("Obuhvaćena predavanja: 1 (Skladišta), 2 (Obrada podataka)");
    expect(message).not.toContain("<lekcija>");
    expect(message).toContain('<ranija_lekcija predavanje="1">');
    expect(message).toContain('<ranija_lekcija predavanje="2">');
    expect(message).toContain("Stream obrada (predavanje 2) [ocena: ~]");
    expect(message).toContain("Skladišta podataka (predavanje 01) — OBAVEZNO u K1");
    expect(message).toContain("Batch obrada (predavanje 02) — dospeva u K2 (nije obavezno ovde)");
    expect(message).toContain("Lambda arhitektura (predavanje 02) (odloženo");
    expect(message).toContain("Obavezne stavke za K1: 1");
    expect(message).toContain("Računanje je slabije.");
    expect(message).toContain("Napravi plan kumulativnog pregleda K1");
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
