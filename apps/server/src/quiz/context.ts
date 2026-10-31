import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { lessonQuizCode, type LessonView, type TopicRating } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { backlogItem, classTable, course, topic as topicTable } from "../db/schema.js";
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
  /** Number of the class the topic belongs to (topic names can repeat across classes). */
  classNumber: number;
  /** The quiz the topic is due in, e.g. "K1". */
  dueQuiz: string;
  reason: string;
  /**
   * The topic is deferred (not yet covered by the lecturer): shown to the planner, never tested.
   * Set by `loadQuizContext` only; absent means not deferred.
   */
  deferred?: boolean;
}

export interface EarlierLesson {
  classNumber: number;
  title: string;
  lessonMd: string;
}

/**
 * How many earlier classes (the most recent ones with weak topics) feed repeat questions; classes
 * with backlog topics are always added on top of that.
 */
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
   * Weak topics of earlier classes (rated ✗ or ~, or with misconception history) plus every
   * unresolved, not deferred backlog topic of an earlier class: repeat candidates. Deferred topics
   * are never repeat candidates. Only from the classes in `earlierLessons`.
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
  // Unresolved backlog items must be coverable as repeats, weak or not.
  const deferredKeys = new Set(
    db
      .select({ name: topicTable.name, classNumber: classTable.number })
      .from(backlogItem)
      .innerJoin(topicTable, eq(topicTable.id, backlogItem.topicId))
      .innerJoin(classTable, eq(classTable.id, topicTable.classId))
      .where(
        and(
          eq(backlogItem.courseId, row.cls.courseId),
          isNull(backlogItem.resolvedAt),
          eq(topicTable.deferred, true),
        ),
      )
      .all()
      .map((b) => JSON.stringify([b.name, b.classNumber])),
  );
  const backlog: BacklogItem[] = loadBacklog(db, row.cls.courseId).map((b) => ({
    ...b,
    deferred: deferredKeys.has(JSON.stringify([b.topic, b.classNumber])),
  }));
  // A deferred topic is never a repeat candidate; it stays in the backlog list only.
  const backlogKeys = new Set(
    backlog.filter((b) => !b.deferred).map((b) => JSON.stringify([b.topic, b.classNumber])),
  );
  const candidatesOf: {
    cls: (typeof earlierClasses)[number];
    lesson: LessonView;
    topics: QuizTopicInput[];
    hasBacklog: boolean;
  }[] = [];
  for (const earlier of earlierClasses) {
    const view = getLessonView(db, earlier.id);
    if (!view) continue;
    const all = view.topics.map(toTopicInput);
    const inBacklog = (t: QuizTopicInput) =>
      backlogKeys.has(JSON.stringify([t.name, earlier.number]));
    // Deferred topics are never repeat candidates, weak or on the backlog.
    const topics = all.filter((t) => !t.deferred && (isRepeatCandidate(t) || inBacklog(t)));
    if (topics.length > 0) {
      candidatesOf.push({ cls: earlier, lesson: view, topics, hasBacklog: topics.some(inBacklog) });
    }
  }
  // Every candidate keeps its lesson. Classes with backlog topics are always kept (the limit is
  // raised for them); the remaining slots go to the most recent classes with weak topics.
  const backlogClasses = candidatesOf.filter((c) => c.hasBacklog);
  const plainSlots = Math.max(0, MAX_EARLIER_LESSONS - backlogClasses.length);
  const plain = candidatesOf.filter((c) => !c.hasBacklog);
  const keptPlain = plainSlots === 0 ? [] : plain.slice(-plainSlots);
  const recent = [...backlogClasses, ...keptPlain].sort((x, y) => x.cls.number - y.cls.number);
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
    backlog,
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
