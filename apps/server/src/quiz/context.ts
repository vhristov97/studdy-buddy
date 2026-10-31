import { and, asc, eq, lt } from "drizzle-orm";
import { lessonQuizCode, type LessonView, type TopicRating } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable, course } from "../db/schema.js";
import { loadBacklog, loadObservations } from "../grading/context.js";
import { getLessonView } from "../repositories/lessons.js";

export interface QuizTopicHistoryEntry {
  source: "notes" | "quiz" | "grading";
  ref: string | null;
  outcome: string | null;
  misconception: string | null;
  correction: string | null;
}

export interface QuizTopicInput {
  name: string;
  rating: TopicRating;
  deferred: boolean;
  deferredNote: string | null;
  /** Oldest first. */
  history: QuizTopicHistoryEntry[];
}

export interface BacklogItem {
  topic: string;
  /** The quiz the topic is due in, e.g. "K1". */
  dueQuiz: string;
  reason: string;
}

export interface EarlierLesson {
  classNumber: number;
  title: string;
  lessonMd: string;
}

/** How many earlier classes (the most recent ones with repeat candidates) feed repeat questions. */
export const MAX_EARLIER_LESSONS = 3;

/** Everything the quiz planner (and, in part, the builder and reviewer) needs about one class. */
export interface QuizContext {
  course: { name: string; persona: string | null; assessmentFormat: string | null };
  class: { id: number; number: number; title: string };
  /** The quiz code for this class, e.g. "P01". */
  code: string;
  lessonMd: string;
  /** Topics of this class, in lesson order. */
  topics: QuizTopicInput[];
  /**
   * Weak topics of earlier classes (rated ✗ or ~, or with misconception history): repeat
   * candidates. Only from the classes in `earlierLessons`.
   */
  earlierTopics: (QuizTopicInput & { classNumber: number })[];
  /**
   * The lessons of the earlier classes that have repeat candidates in `earlierTopics`, oldest
   * first; the source material for repeat questions. Limited to the most recent classes.
   */
  earlierLessons: EarlierLesson[];
  /** The course's unresolved backlog items (the planner picks the ones due in this class's cumulative quiz). */
  backlog: BacklogItem[];
  /** Cross-course learner observations, oldest first. */
  observations: string[];
}

export interface NotesMisconception {
  topic: string;
  claim: string;
  correction: string;
}

export function toTopicInput(topic: LessonView["topics"][number]): QuizTopicInput {
  return {
    name: topic.name,
    rating: topic.rating,
    deferred: topic.deferred,
    deferredNote: topic.deferredNote,
    history: topic.events.map((e) => ({
      source: e.source,
      ref: e.ref,
      outcome: e.outcome,
      misconception: e.misconceptionText,
      correction: e.correctionText,
    })),
  };
}

/** A not-deferred topic is a repeat candidate when it is weak or ever produced a misconception. */
function isRepeatCandidate(topic: QuizTopicInput): boolean {
  if (topic.deferred) return false;
  return (
    topic.rating === "✗" ||
    topic.rating === "~" ||
    topic.history.some((h) => h.misconception !== null)
  );
}

/** Loads the quiz planner's context for a class. Throws when the class or its lesson is missing. */
export function loadQuizContext(db: Db, classId: number): QuizContext {
  const row = db
    .select({ cls: classTable, course })
    .from(classTable)
    .innerJoin(course, eq(course.id, classTable.courseId))
    .where(eq(classTable.id, classId))
    .get();
  if (!row) throw new Error(`Class ${classId} does not exist.`);

  const lesson = getLessonView(db, classId);
  if (!lesson) throw new Error(`Class ${classId} has no lesson yet; generate the lesson first.`);

  const earlierClasses = db
    .select()
    .from(classTable)
    .where(and(eq(classTable.courseId, row.cls.courseId), lt(classTable.number, row.cls.number)))
    .orderBy(asc(classTable.number))
    .all();
  const withCandidates: {
    cls: (typeof earlierClasses)[number];
    lesson: LessonView;
    topics: QuizTopicInput[];
  }[] = [];
  for (const earlier of earlierClasses) {
    const view = getLessonView(db, earlier.id);
    if (!view) continue;
    const candidates = view.topics.map(toTopicInput).filter(isRepeatCandidate);
    if (candidates.length > 0)
      withCandidates.push({ cls: earlier, lesson: view, topics: candidates });
  }
  // Every candidate keeps its lesson: only the most recent classes with candidates are used.
  const recent = withCandidates.slice(-MAX_EARLIER_LESSONS);
  const earlierTopics: QuizContext["earlierTopics"] = recent.flatMap((c) =>
    c.topics.map((t) => ({ ...t, classNumber: c.cls.number })),
  );
  const earlierLessons: EarlierLesson[] = recent.map((c) => ({
    classNumber: c.cls.number,
    title: c.cls.title,
    lessonMd: c.lesson.bodyMd,
  }));

  return {
    course: {
      name: row.course.name,
      persona: row.course.persona,
      assessmentFormat: row.course.assessmentFormat,
    },
    class: { id: row.cls.id, number: row.cls.number, title: row.cls.title },
    code: lessonQuizCode(row.cls.number),
    lessonMd: lesson.bodyMd,
    topics: lesson.topics.map(toTopicInput),
    earlierTopics,
    earlierLessons,
    backlog: loadBacklog(db, row.cls.courseId),
    observations: loadObservations(db),
  };
}

/** The misconceptions found in the student's notes, per topic of this class. */
export function notesMisconceptions(ctx: QuizContext): NotesMisconception[] {
  return ctx.topics.flatMap((t) =>
    t.history.flatMap((h) =>
      h.source === "notes" && h.misconception !== null
        ? [{ topic: t.name, claim: h.misconception, correction: h.correction ?? "" }]
        : [],
    ),
  );
}
