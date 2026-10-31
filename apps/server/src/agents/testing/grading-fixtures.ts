import { scoreQuiz, type GradingResult, type SubmissionAnswers } from "@studdy/shared";
import type { GradingContext } from "../../grading/context.js";
import { MISCONCEPTION, ctxFixture, planFixture, quizFixture } from "./quiz-fixtures.js";

/** Test-only. Hand-written grading fixtures; no real course material. */

/**
 * Answers to `quizFixture()`: q1 correct, q2 wrong, q3 "Ne znam", q4 wrong number, q5 partial
 * (row 0 right, row 1 "Ne znam", row 2 wrong), q6 unanswered, q7 an open answer, q8 "Ne znam".
 */
export function answersFixture(): SubmissionAnswers {
  return {
    q1: 1,
    q2: 0,
    q3: "?",
    q4: 11,
    q5: { "0": 1, "1": "?", "2": 1 },
    q7: "Batch skuplja podatke pa ih obradi odjednom.",
    q8: "?",
  };
}

export function gradingCtxFixture(overrides: Partial<GradingContext> = {}): GradingContext {
  const quiz = quizFixture();
  const answers = answersFixture();
  const score = scoreQuiz(quiz, answers);
  const base = ctxFixture();
  const [batch, stream] = base.topics;
  const [warehouse] = base.earlierTopics;
  const [lambda] = base.topics.slice(2);
  return {
    course: {
      id: 1,
      name: "Kurs za test",
      persona: null,
      assessmentFormat: null,
      reviewCadence: 4,
    },
    quiz: { ...quiz, id: 7, classId: 2 },
    plan: planFixture(),
    submission: {
      id: 3,
      submittedAt: "2026-05-01T10:00:00.000Z",
      answers,
      results: score.results,
      autoScore: score.autoScore,
      autoMax: score.autoMax,
      dontKnow: score.dontKnow,
    },
    lessons: [
      { classNumber: 1, title: "Skladišta", lessonMd: base.earlierLessons[0]!.lessonMd },
      { classNumber: 2, title: "Obrada podataka", lessonMd: base.lessonMd },
    ],
    topics: [{ ...batch!, classNumber: 2 }, { ...stream!, classNumber: 2 }, { ...warehouse! }],
    questionTopics: [
      { questionId: "q1", topic: "Batch obrada", classNumber: 2 },
      { questionId: "q2", topic: "Stream obrada", classNumber: 2 },
      { questionId: "q3", topic: "Stream obrada", classNumber: 2 },
      { questionId: "q4", topic: "Batch obrada", classNumber: 2 },
      { questionId: "q5", topic: "Stream obrada", classNumber: 2 },
      { questionId: "q6", topic: "Skladišta podataka", classNumber: 1 },
      { questionId: "q7", topic: "Batch obrada", classNumber: 2 },
      { questionId: "q8", topic: "Stream obrada", classNumber: 2 },
    ],
    leftOutTopics: [{ ...lambda!, classNumber: 2, reason: "Odloženo, tema nije obrađena." }],
    nextCumulativeCode: "K1",
    dueQuizByClass: {},
    observations: [],
    backlog: [],
    nextSteps: [],
    ...overrides,
  };
}

/** A result that satisfies `gradingResultSchema(gradingCtxFixture())`. */
export function gradingResultFixture(): GradingResult {
  return {
    autoCheck: { agrees: true, note: null },
    openGrades: [
      {
        questionId: "q7",
        score: 0.4,
        right: "Batch obrađuje podatke odjednom.",
        missing: "Nije navedena propusnost ni primer iz predavanja.",
      },
    ],
    items: [
      {
        questionId: "q2",
        rowIndex: null,
        topic: "Stream obrada",
        classification: "misconception",
        studentAnswer: "Prva opcija ovde",
        misconception: "Stream čeka da se skupi ceo skup podataka.",
        likelyCause: "Pomešao stream sa batch obradom.",
        keyFact: "Stream obrađuje događaje čim stignu.",
      },
      {
        questionId: "q3",
        rowIndex: null,
        topic: "Stream obrada",
        classification: "gap",
        studentAnswer: null,
        misconception: null,
        likelyCause: null,
        keyFact: "Stream obrađuje događaje jedan po jedan.",
      },
      {
        questionId: "q4",
        rowIndex: null,
        topic: "Batch obrada",
        classification: "misconception",
        studentAnswer: "11 min",
        misconception: "Procenio je vreme umesto da izračuna.",
        likelyCause: "Procena umesto računa.",
        keyFact: "120 / 10 = 12 minuta.",
      },
      {
        questionId: "q5",
        rowIndex: 1,
        topic: "Stream obrada",
        classification: "gap",
        studentAnswer: null,
        misconception: null,
        likelyCause: null,
        keyFact: "Spark je alat za obradu.",
      },
      {
        questionId: "q5",
        rowIndex: 2,
        topic: "Stream obrada",
        classification: "misconception",
        studentAnswer: "Log događaja",
        misconception: "HDFS je log događaja.",
        likelyCause: null,
        keyFact: "HDFS je skladište.",
      },
      {
        questionId: "q6",
        rowIndex: null,
        topic: "Skladišta podataka",
        classification: "gap",
        studentAnswer: null,
        misconception: null,
        likelyCause: null,
        keyFact: "Lake čuva sirove podatke, warehouse strukturirane.",
      },
      {
        questionId: "q7",
        rowIndex: null,
        topic: "Batch obrada",
        classification: "partial",
        studentAnswer: "Batch skuplja podatke pa ih obradi odjednom.",
        misconception: null,
        likelyCause: null,
        keyFact: "Batch optimizuje propusnost; nabrojati sve tri tačke.",
      },
      {
        questionId: "q8",
        rowIndex: null,
        topic: "Stream obrada",
        classification: "gap",
        studentAnswer: null,
        misconception: null,
        likelyCause: null,
        keyFact: "Uporedi latenciju i propusnost.",
      },
    ],
    correctFixes: [{ topic: "Batch obrada", misconception: MISCONCEPTION }],
    topicUpdates: [
      { topic: "Batch obrada", classNumber: 2, rating: "~", note: "q1 tačno, q4 pogrešno" },
      { topic: "Stream obrada", classNumber: 2, rating: "✗", note: "q2 zabluda, ostalo ne znam" },
      { topic: "Skladišta podataka", classNumber: 1, rating: "✗", note: "q6 ne znam" },
    ],
    backlogAdd: [
      { topic: "Stream obrada", classNumber: 2, dueQuiz: "K1", reason: "weak" },
      { topic: "Skladišta podataka", classNumber: 1, dueQuiz: "K1", reason: "gap" },
      { topic: "Lambda arhitektura", classNumber: 2, dueQuiz: "K1", reason: "left_out" },
    ],
    backlogResolve: [],
    observations: ["Računanje je slabije: procenjuje umesto da računa."],
    nextSteps: ["Objasni Skladišta podataka pre sledećeg testa.", "Usmeno: batch obrada."],
    writeupMd: "## Rezultat\n\n| Stavka | Vrednost |\n|---|---|\n| Automatski | 1 / 6 |\n",
  };
}
