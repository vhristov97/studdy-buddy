import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { LessonView, Quiz, QuizPlan, QuestionResult, SubmissionAnswers } from "@studdy/shared";
import type { Db } from "../db/client.js";
import {
  backlogItem,
  classTable,
  course,
  learnerObservation,
  nextStep,
  quizPlan,
  submission,
  topic,
} from "../db/schema.js";
import { getLessonView } from "../repositories/lessons.js";
import { getFullQuiz } from "../repositories/quizzes.js";
import { nextFreeCumulativeCode, parseCumulativeCode } from "../quiz/cumulative.js";
import { toTopicInput, type BacklogItem, type QuizTopicInput } from "../quiz/context.js";

export type GradingTopic = QuizTopicInput & { classNumber: number };

/** Everything the grader needs about one submission. */
export interface GradingContext {
  course: {
    id: number;
    name: string;
    persona: string | null;
    assessmentFormat: string | null;
    reviewCadence: number | null;
  };
  quiz: Quiz & { id: number; classId: number | null };
  /** The planner's plan for the quiz (server-only); null for quizzes without one. */
  plan: QuizPlan | null;
  submission: {
    id: number;
    /** ISO 8601. */
    submittedAt: string;
    answers: SubmissionAnswers;
    results: QuestionResult[];
    autoScore: number;
    autoMax: number;
    /** "q3" or "q14.r2" ids. */
    dontKnow: string[];
  };
  /** The quiz's class lesson plus the lessons of the classes its repeat topics come from, oldest first. */
  lessons: { classNumber: number; title: string; lessonMd: string }[];
  /**
   * Every topic the quiz's questions reference: this class's topics by name, repeats resolved to
   * the earlier class's topic of that name. Each gets a rating update.
   */
  topics: GradingTopic[];
  /** The topic of each question, so a question can be traced to its topic row. */
  questionTopics: { questionId: string; topic: string; classNumber: number }[];
  /** Topics the plan left out of the quiz (resolved to topic rows); they go to the backlog as left_out. */
  leftOutTopics: (GradingTopic & { reason: string })[];
  /**
   * The cumulative quiz a gap found here is mandatory in: a "K<n>" that does not exist yet (see
   * {@link nextCumulativeCode}); for a cumulative quiz "K<n>" itself, the next free one after it.
   */
  nextCumulativeCode: string;
  /** Cross-course observations about the student, oldest first (the newest {@link MAX_OBSERVATIONS}). */
  observations: string[];
  /** The course's unresolved backlog items. */
  backlog: BacklogItem[];
  /** The course's current "Sledeće" list, in order. */
  nextSteps: string[];
}

/** How many observations the grader sees. */
export const MAX_OBSERVATIONS = 50;

/** Observations are shared across courses; the newest {@link MAX_OBSERVATIONS}, oldest first. */
export function loadObservations(db: Db): string[] {
  return db
    .select({ text: learnerObservation.text })
    .from(learnerObservation)
    .orderBy(desc(learnerObservation.id))
    .limit(MAX_OBSERVATIONS)
    .all()
    .map((r) => r.text)
    .reverse();
}

export function loadBacklog(db: Db, courseId: number): BacklogItem[] {
  return db
    .select({
      topic: topic.name,
      classNumber: classTable.number,
      dueQuiz: backlogItem.dueQuiz,
      reason: backlogItem.reason,
    })
    .from(backlogItem)
    .innerJoin(topic, eq(topic.id, backlogItem.topicId))
    .innerJoin(classTable, eq(classTable.id, topic.classId))
    .where(and(eq(backlogItem.courseId, courseId), isNull(backlogItem.resolvedAt)))
    .orderBy(asc(backlogItem.id))
    .all();
}

export function loadNextSteps(db: Db, courseId: number): string[] {
  return db
    .select({ text: nextStep.text })
    .from(nextStep)
    .where(eq(nextStep.courseId, courseId))
    .orderBy(asc(nextStep.position), asc(nextStep.id))
    .all()
    .map((r) => r.text);
}

/**
 * The review a gap found in this class is mandatory in: the smallest `K<n>` above every existing
 * review of the course and, with a cadence, no earlier than the one scheduled for the class
 * (n = ceil(classNumber / cadence)). Never the code of a review that already exists.
 */
export function nextCumulativeCode(
  db: Db,
  courseId: number,
  classNumber: number,
  cadence: number | null,
): string {
  const scheduled = cadence === null || cadence < 1 ? 1 : Math.ceil(classNumber / cadence);
  return nextFreeCumulativeCode(db, courseId, { atLeast: scheduled });
}

interface ClassEntry {
  id: number;
  number: number;
  title: string;
  view: LessonView | undefined;
}

/** Loads the grader's context for a submission. Throws when the submission or its quiz is missing. */
export function loadGradingContext(db: Db, submissionId: number): GradingContext {
  const sub = db.select().from(submission).where(eq(submission.id, submissionId)).get();
  if (!sub) throw new Error(`Submission ${submissionId} does not exist.`);
  const full = getFullQuiz(db, sub.quizId);
  if (!full) throw new Error(`Quiz ${sub.quizId} of submission ${submissionId} does not exist.`);
  const quizRow = full.row;

  const courseRow = db.select().from(course).where(eq(course.id, quizRow.courseId)).get();
  if (!courseRow) throw new Error(`Course ${quizRow.courseId} does not exist.`);

  const planRow = db
    .select()
    .from(quizPlan)
    .where(eq(quizPlan.quizId, quizRow.id))
    .orderBy(desc(quizPlan.id))
    .get();
  const plan = planRow?.planJson ?? null;

  const classes = db
    .select()
    .from(classTable)
    .where(eq(classTable.courseId, courseRow.id))
    .orderBy(asc(classTable.number))
    .all();
  const viewCache = new Map<number, ClassEntry>();
  const entryOf = (cls: (typeof classes)[number]): ClassEntry => {
    let entry = viewCache.get(cls.id);
    if (!entry) {
      entry = {
        id: cls.id,
        number: cls.number,
        title: cls.title,
        view: getLessonView(db, cls.id),
      };
      viewCache.set(cls.id, entry);
    }
    return entry;
  };

  const currentClass =
    quizRow.classId === null ? undefined : classes.find((c) => c.id === quizRow.classId);
  // A cumulative quiz "K<n>" belongs to no class: it counts as following the latest class, and the
  // review that follows it is K<n+1>.
  const reviewNumber = quizRow.classId === null ? parseCumulativeCode(quizRow.code) : null;
  const classNumber = currentClass?.number ?? Math.max(1, ...classes.map((c) => c.number));
  const earlier = classes
    .filter((c) => (currentClass ? c.number < currentClass.number : true))
    .reverse(); // most recent first

  /**
   * The topic row for a name. A repeat with the plan's class number is looked up in exactly that
   * class; otherwise (plans from before the class number existed, or no match) the current class
   * comes first and repeats prefer the most recent earlier classes.
   */
  const resolveTopic = (
    name: string,
    isRepeat: boolean,
    repeatClassNumber: number | null = null,
  ): { entry: ClassEntry; topic: QuizTopicInput } | undefined => {
    if (isRepeat && repeatClassNumber !== null) {
      const cls = earlier.find((c) => c.number === repeatClassNumber);
      if (cls) {
        const entry = entryOf(cls);
        const found = entry.view?.topics.find((t) => t.name === name);
        if (found) return { entry, topic: toTopicInput(found) };
      }
    }
    const order = currentClass
      ? isRepeat
        ? [...earlier, currentClass]
        : [currentClass, ...earlier]
      : earlier;
    for (const cls of order) {
      const entry = entryOf(cls);
      const found = entry.view?.topics.find((t) => t.name === name);
      if (found) return { entry, topic: toTopicInput(found) };
    }
    return undefined;
  };

  const topics: GradingTopic[] = [];
  const questionTopics: GradingContext["questionTopics"] = [];
  const lessonClasses = new Map<number, ClassEntry>();
  if (currentClass) lessonClasses.set(currentClass.id, entryOf(currentClass));

  for (const q of full.quiz.questions) {
    const planQuestion = plan?.questions.find((p) => p.id === q.id);
    const isRepeat = planQuestion?.isRepeat ?? false;
    // Plans stored before classNumber existed lack the field.
    const resolved = resolveTopic(q.topic, isRepeat, planQuestion?.classNumber ?? null);
    if (!resolved) continue;
    const { entry, topic } = resolved;
    questionTopics.push({ questionId: q.id, topic: topic.name, classNumber: entry.number });
    lessonClasses.set(entry.id, entry);
    if (!topics.some((t) => t.name === topic.name && t.classNumber === entry.number)) {
      topics.push({ ...topic, classNumber: entry.number });
    }
  }

  const leftOutTopics: GradingContext["leftOutTopics"] = [];
  // A cumulative review's left-out topics are not carried to the backlog (they were not new gaps).
  for (const left of reviewNumber === null ? (plan?.leftOut ?? []) : []) {
    const resolved = resolveTopic(left.topic, false);
    if (!resolved) continue;
    if (leftOutTopics.some((t) => t.name === left.topic)) continue;
    leftOutTopics.push({
      ...resolved.topic,
      classNumber: resolved.entry.number,
      reason: left.reason,
    });
  }

  const lessons = [...lessonClasses.values()]
    .filter((e) => e.view !== undefined)
    .sort((a, b) => a.number - b.number)
    .map((e) => ({ classNumber: e.number, title: e.title, lessonMd: e.view!.bodyMd }));

  return {
    course: {
      id: courseRow.id,
      name: courseRow.name,
      persona: courseRow.persona,
      assessmentFormat: courseRow.assessmentFormat,
      reviewCadence: courseRow.reviewCadence,
    },
    quiz: { ...full.quiz, id: quizRow.id, classId: quizRow.classId },
    plan,
    submission: {
      id: sub.id,
      submittedAt: sub.submittedAt.toISOString(),
      answers: sub.answersJson,
      results: sub.resultsJson,
      autoScore: sub.autoScore,
      autoMax: sub.autoMax,
      dontKnow: sub.dontKnowJson,
    },
    lessons,
    topics,
    questionTopics,
    leftOutTopics,
    nextCumulativeCode:
      reviewNumber === null
        ? nextCumulativeCode(db, courseRow.id, classNumber, courseRow.reviewCadence)
        : nextFreeCumulativeCode(db, courseRow.id, { after: reviewNumber }),
    observations: loadObservations(db),
    backlog: loadBacklog(db, courseRow.id),
    nextSteps: loadNextSteps(db, courseRow.id),
  };
}
