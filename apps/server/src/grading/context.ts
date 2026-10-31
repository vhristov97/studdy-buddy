import { asc, desc, eq } from "drizzle-orm";
import type { LessonView, Quiz, QuizPlan, QuestionResult, SubmissionAnswers } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable, course, quizPlan, submission } from "../db/schema.js";
import { getLessonView } from "../repositories/lessons.js";
import { getFullQuiz } from "../repositories/quizzes.js";
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
  /** The cumulative quiz that follows this class, "K<n>"; "K1" when the course has no cadence. */
  nextCumulativeCode: string;
  /** Cross-course observations about the student. Empty until the table exists (M6.2). */
  observations: string[];
  /** Topics already on the backlog. Empty until the table exists (M6.2). */
  backlog: BacklogItem[];
  /** The current "Sledeće" list. Empty until the table exists (M6.2). */
  nextSteps: string[];
}

// M6.2 fills these three in from their tables (they will take `db` and the course id then).
function loadObservations(): string[] {
  return [];
}

function loadBacklog(): BacklogItem[] {
  return [];
}

function loadNextSteps(): string[] {
  return [];
}

/** "K<n>" with n = ceil(classNumber / cadence), or "K1" when the course has no cadence. */
export function nextCumulativeCode(classNumber: number, cadence: number | null): string {
  if (cadence === null || cadence < 1) return "K1";
  return `K${Math.max(1, Math.ceil(classNumber / cadence))}`;
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
  // A cumulative quiz belongs to no class; it counts as following the latest class.
  const classNumber = currentClass?.number ?? Math.max(1, ...classes.map((c) => c.number));
  const earlier = classes
    .filter((c) => (currentClass ? c.number < currentClass.number : true))
    .reverse(); // most recent first

  /** The topic row for a name: the current class first, repeats prefer earlier classes. */
  const resolveTopic = (
    name: string,
    isRepeat: boolean,
  ): { entry: ClassEntry; topic: QuizTopicInput } | undefined => {
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
    const isRepeat = plan?.questions.find((p) => p.id === q.id)?.isRepeat ?? false;
    const resolved = resolveTopic(q.topic, isRepeat);
    if (!resolved) continue;
    const { entry, topic } = resolved;
    questionTopics.push({ questionId: q.id, topic: topic.name, classNumber: entry.number });
    lessonClasses.set(entry.id, entry);
    if (!topics.some((t) => t.name === topic.name && t.classNumber === entry.number)) {
      topics.push({ ...topic, classNumber: entry.number });
    }
  }

  const leftOutTopics: GradingContext["leftOutTopics"] = [];
  for (const left of plan?.leftOut ?? []) {
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
    nextCumulativeCode: nextCumulativeCode(classNumber, courseRow.reviewCadence),
    observations: loadObservations(),
    backlog: loadBacklog(),
    nextSteps: loadNextSteps(),
  };
}
