import type { Quiz, QuizPlan } from "@studdy/shared";
import type { QuizContext } from "../../quiz/context.js";

/** Test-only. Small hand-written quiz fixtures; no real course material. */

export const MISCONCEPTION = "Batch je uvek sporiji od stream obrade";

export function ctxFixture(overrides: Partial<QuizContext> = {}): QuizContext {
  return {
    kind: "lesson",
    coveredClasses: [],
    course: { name: "Kurs za test", persona: null, assessmentFormat: null },
    class: { id: 2, number: 2, title: "Obrada podataka" },
    code: "P02",
    lessonMd:
      "Uvod.\n\n## Batch obrada\n\n- Batch optimizuje propusnost.\n\n> ⚠️ Ispravka: batch je uvek sporiji — nije tačno\n\n## Stream obrada\n\n- (P) Stream obrađuje događaje.",
    topics: [
      {
        name: "Batch obrada",
        rating: "?",
        deferred: false,
        deferredNote: null,
        history: [
          {
            source: "notes",
            ref: null,
            outcome: "misconception",
            misconception: MISCONCEPTION,
            correction: "Batch optimizuje propusnost, ne latenciju.",
          },
        ],
      },
      { name: "Stream obrada", rating: "?", deferred: false, deferredNote: null, history: [] },
      {
        name: "Lambda arhitektura",
        rating: "?",
        deferred: true,
        deferredNote: "Na sledećem času.",
        history: [],
      },
    ],
    earlierTopics: [
      {
        classNumber: 1,
        name: "Skladišta podataka",
        rating: "✗",
        deferred: false,
        deferredNote: null,
        history: [
          {
            source: "quiz",
            ref: "P01",
            outcome: "wrong",
            misconception: "Data lake je isto što i data warehouse",
            correction: "Lake čuva sirove podatke, warehouse strukturirane.",
          },
        ],
      },
    ],
    earlierLessons: [
      {
        classNumber: 1,
        title: "Skladišta",
        lessonMd: "## Skladišta podataka\n\n- Lake čuva sirove podatke, warehouse strukturirane.",
      },
    ],
    backlog: [],
    observations: [],
    ...overrides,
  };
}

function plannedQuestion(
  id: number,
  type: QuizPlan["questions"][number]["type"],
  topic: string,
  extra: Partial<QuizPlan["questions"][number]> = {},
): QuizPlan["questions"][number] {
  return {
    id: `q${id}`,
    type,
    topic,
    angle: "Scenario sa timom koji bira pristup.",
    answer: "Tačan odgovor.",
    keyPoints: type === "open" ? ["Prva tačka", "Druga tačka"] : [],
    mcCorrectIndex: null,
    mcOptionCount: null,
    ref: "Obrada › Primer",
    extra: false,
    targetsMisconception: null,
    isRepeat: false,
    classNumber: null,
    ...extra,
  };
}

export function planFixture(): QuizPlan {
  const mc = (id: number, topic: string, index: number, extra = {}) =>
    plannedQuestion(id, "mc", topic, { mcCorrectIndex: index, mcOptionCount: 4, ...extra });
  return {
    code: "P02",
    title: "Obrada podataka",
    subtitle: "Predavanje 2",
    chips: ["Predavanje 2", "8 pitanja", "~15 min"],
    lessonsToRead: ["Obrada podataka"],
    targetMinutes: 15,
    typeMix: { mc: 4, num: 1, match: 1, open: 2 },
    weightingRationale: "Zabluda o batch obradi je glavni distraktor; ponavlja se skladište.",
    leftOut: [{ topic: "Lambda arhitektura", reason: "Odloženo, tema nije obrađena." }],
    questions: [
      mc(1, "Batch obrada", 1, { targetsMisconception: MISCONCEPTION }),
      mc(2, "Stream obrada", 2),
      mc(3, "Stream obrada", 0),
      plannedQuestion(4, "num", "Batch obrada", { answer: "12 min" }),
      plannedQuestion(5, "match", "Stream obrada"),
      mc(6, "Skladišta podataka", 3, {
        isRepeat: true,
        classNumber: 1,
        ref: "Predavanje 1 › Skladišta podataka",
      }),
      plannedQuestion(7, "open", "Batch obrada"),
      plannedQuestion(8, "open", "Stream obrada"),
    ],
  };
}

function builtMc(
  id: number,
  topic: string,
  correct: number,
  ref = "Obrada › Primer",
): Quiz["questions"][number] {
  const options = [
    "Prva opcija ovde",
    "Druga opcija ovde",
    "Treća opcija ovde",
    "Četvrta opcija ovde",
  ];
  return {
    id: `q${id}`,
    type: "mc",
    topic,
    prompt: `Pitanje ${id}: koji pristup tim bira?`,
    ref,
    extra: false,
    options,
    answer: correct,
    explanation: "Tačno zato što je to ta opcija; druga zavodi jer meša pojmove.",
  };
}

/** A quiz that satisfies `planFixture()` and has no checker errors or warnings. */
export function quizFixture(): Quiz {
  return {
    code: "P02",
    title: "Obrada podataka",
    subtitle: "Predavanje 2",
    chips: ["Predavanje 2", "8 pitanja", "~15 min"],
    questions: [
      builtMc(1, "Batch obrada", 1),
      builtMc(2, "Stream obrada", 2),
      builtMc(3, "Stream obrada", 0),
      {
        id: "q4",
        type: "num",
        topic: "Batch obrada",
        prompt: "Koliko minuta traje job od 120 zapisa pri 10 zapisa u minuti?",
        ref: "Obrada › Primer",
        extra: false,
        answer: 12,
        tolerance: 0,
        unit: "min",
        explanation: "120 podeljeno sa 10 daje 12 minuta; to je propusnost batch obrade.",
      },
      {
        id: "q5",
        type: "match",
        topic: "Stream obrada",
        prompt: "Poveži alat sa ulogom.",
        ref: "Obrada › Primer",
        extra: false,
        rows: ["Kafka", "Spark", "HDFS"],
        choices: ["Skladište", "Log događaja", "Obrada"],
        answer: [1, 2, 0],
        explanation: "Kafka je log događaja, Spark obrada, HDFS skladište.",
      },
      builtMc(6, "Skladišta podataka", 3, "Predavanje 1 › Skladišta podataka"),
      {
        id: "q7",
        type: "open",
        topic: "Batch obrada",
        prompt: "Objasni zašto batch optimizuje propusnost.",
        ref: "Obrada › Primer",
        extra: false,
        keyPoints: ["Prva tačka", "Druga tačka", "Treća tačka"],
      },
      {
        id: "q8",
        type: "open",
        topic: "Stream obrada",
        prompt: "Uporedi batch i stream obradu.",
        ref: "Obrada › Primer",
        extra: false,
        keyPoints: ["Prva tačka", "Druga tačka"],
      },
    ],
  };
}

/** A cumulative review K1 over classes 1..2: no current class, every topic of both classes. */
export function cumulativeCtxFixture(overrides: Partial<QuizContext> = {}): QuizContext {
  const base = ctxFixture();
  const topic = (name: string, rating: "?" | "✗" | "~" | "✓", classNumber: number) => ({
    name,
    rating,
    deferred: false,
    deferredNote: null,
    history: [],
    classNumber,
  });
  return {
    ...base,
    kind: "cumulative",
    class: { id: 2, number: 2, title: "Obrada podataka" },
    coveredClasses: [
      { classNumber: 1, title: "Skladišta" },
      { classNumber: 2, title: "Obrada podataka" },
    ],
    code: "K1",
    lessonMd: "",
    topics: [],
    earlierTopics: [
      base.earlierTopics[0]!,
      topic("Batch obrada", "✓", 2),
      topic("Stream obrada", "~", 2),
    ],
    earlierLessons: [
      base.earlierLessons[0]!,
      { classNumber: 2, title: "Obrada podataka", lessonMd: base.lessonMd },
    ],
    backlog: [],
    ...overrides,
  };
}

/** A plan that satisfies `cumulativeCtxFixture()`: every row a repeat with its class number. */
export function cumulativePlanFixture(): QuizPlan {
  const base = planFixture();
  const classOf: Record<string, number> = {
    "Batch obrada": 2,
    "Stream obrada": 2,
    "Skladišta podataka": 1,
  };
  return {
    ...base,
    code: "K1",
    title: "Kumulativni pregled 1",
    subtitle: "Predavanja 1-2 · kumulativni test",
    leftOut: [],
    questions: base.questions.map((q) => ({
      ...q,
      isRepeat: true,
      classNumber: classOf[q.topic]!,
      ref: `Predavanje ${classOf[q.topic]} › Odeljak`,
      targetsMisconception: null,
    })),
  };
}
