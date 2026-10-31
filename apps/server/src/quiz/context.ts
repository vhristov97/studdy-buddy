import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { lessonQuizCode, type LessonView, type TopicRating } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { backlogItem, classTable, course, topic as topicTable } from "../db/schema.js";
import { loadBacklog, loadObservations } from "../grading/context.js";
import { getLessonView } from "../repositories/lessons.js";
import { parseCumulativeCode, readyClasses, resolveCumulativeTarget } from "./cumulative.js";

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
  /** `lesson`: the per-class quiz "P<NN>"; `cumulative`: the review "K<n>" over several classes. */
  kind: "lesson" | "cumulative";
  course: { name: string; persona: string | null; assessmentFormat: string | null };
  /** The class of the quiz; for a cumulative review the highest class it covers. */
  class: { id: number; number: number; title: string };
  /** The classes a cumulative review covers, by number; empty for a lesson quiz. */
  coveredClasses: { classNumber: number; title: string }[];
  /** The quiz code: "P01" for a class, "K1" for a cumulative review. */
  code: string;
  /** The class's lesson; empty for a cumulative review (all its lessons are in `earlierLessons`). */
  lessonMd: string;
  /** Topics of this class, in lesson order; empty for a cumulative review (no "current class"). */
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

/**
 * The unresolved backlog of a course with deferred items marked: a deferred topic stays on the list
 * for the planner to see but is never tested.
 */
export function loadBacklogWithDeferred(db: Db, courseId: number): BacklogItem[] {
  const deferredKeys = new Set(
    db
      .select({ name: topicTable.name, classNumber: classTable.number })
      .from(backlogItem)
      .innerJoin(topicTable, eq(topicTable.id, backlogItem.topicId))
      .innerJoin(classTable, eq(classTable.id, topicTable.classId))
      .where(
        and(
          eq(backlogItem.courseId, courseId),
          isNull(backlogItem.resolvedAt),
          eq(topicTable.deferred, true),
        ),
      )
      .all()
      .map((b) => JSON.stringify([b.name, b.classNumber])),
  );
  return loadBacklog(db, courseId).map((b) => ({
    ...b,
    deferred: deferredKeys.has(JSON.stringify([b.topic, b.classNumber])),
  }));
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
  const backlog = loadBacklogWithDeferred(db, row.cls.courseId);
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
    kind: "lesson",
    course: {
      name: row.course.name,
      persona: row.course.persona,
      assessmentFormat: row.course.assessmentFormat,
    },
    class: { id: row.cls.id, number: row.cls.number, title: row.cls.title },
    coveredClasses: [],
    code: lessonQuizCode(row.cls.number),
    lessonMd: lesson.bodyMd,
    topics: lesson.topics.map(toTopicInput),
    earlierTopics,
    earlierLessons,
    backlog,
    observations: loadObservations(db),
  };
}

/**
 * Total lesson characters a cumulative review's planner, builder and reviewer get; beyond that
 * every lesson is cut proportionally (see {@link loadCumulativeContext}).
 */
export const MAX_CUMULATIVE_LESSON_CHARS = 200_000;

export interface CumulativeContextOptions {
  /** The review covers the ready classes up to and including this class number. Default: from the code. */
  coversThrough?: number;
  /** Override of {@link MAX_CUMULATIVE_LESSON_CHARS} (tests). */
  maxLessonChars?: number;
  /** Called with a message when lessons had to be shortened. */
  onWarn?: (message: string) => void;
}

const TRUNCATION_MARK = "[... ostatak lekcije izostavljen zbog obima; naslovi izostavljenog dela: ";

/** Cuts a lesson to about `limit` characters at a line boundary and lists the headings that were cut off. */
function truncateLesson(lessonMd: string, limit: number): string {
  if (lessonMd.length <= limit) return lessonMd;
  let cut = lessonMd.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > limit * 0.8) cut = cut.slice(0, lastBreak);
  const headings = lessonMd
    .slice(cut.length)
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, "").trim());
  return `${cut.trimEnd()}\n\n${TRUNCATION_MARK}${headings.length > 0 ? headings.join("; ") : "nema"}]`;
}

/**
 * Loads the planner's context for the cumulative review `code` (spec §11), covering every ready
 * class up to `opts.coversThrough` (default: what the code stands for, see
 * `resolveCumulativeTarget`). Throws when nothing can be covered.
 *
 * Differences from a lesson quiz: no current class (`topics` is empty, `lessonMd` is ""); all
 * covered lessons are in `earlierLessons`; `earlierTopics` has every not deferred topic of the
 * covered classes (not only the weak ones), so the planner can see the whole picture; `backlog`
 * is the unresolved items of the covered classes. When the lessons together exceed the size limit,
 * each is cut proportionally to its length and ends with the list of headings that were cut off.
 */
export function loadCumulativeContext(
  db: Db,
  courseId: number,
  code: string,
  opts: CumulativeContextOptions = {},
): QuizContext {
  if (parseCumulativeCode(code) === null) throw new Error(`"${code}" is not a cumulative code.`);
  const courseRow = db.select().from(course).where(eq(course.id, courseId)).get();
  if (!courseRow) throw new Error(`Course ${courseId} does not exist.`);

  const ready = readyClasses(db, courseId);
  const throughNumber =
    opts.coversThrough ?? resolveCumulativeTarget(db, courseId, code).throughClass.number;
  const covered = ready.filter((c) => c.number <= throughNumber);
  const highest = covered.at(-1);
  if (!highest) throw new Error(`Course ${courseId} has no ready class to cover.`);

  const views = covered.map((cls) => ({ cls, view: getLessonView(db, cls.id)! }));
  const maxChars = opts.maxLessonChars ?? MAX_CUMULATIVE_LESSON_CHARS;
  const total = views.reduce((sum, v) => sum + v.view.bodyMd.length, 0);
  const scale = total > maxChars ? maxChars / total : 1;
  if (scale < 1) {
    opts.onWarn?.(
      `The lessons of ${code} total ${total} characters (limit ${maxChars}); each is cut to ${Math.round(scale * 100)}%.`,
    );
  }

  const earlierLessons: EarlierLesson[] = views.map(({ cls, view }) => ({
    classNumber: cls.number,
    title: cls.title,
    lessonMd:
      scale < 1 ? truncateLesson(view.bodyMd, Math.floor(view.bodyMd.length * scale)) : view.bodyMd,
  }));
  const earlierTopics: QuizContext["earlierTopics"] = views.flatMap(({ cls, view }) =>
    view.topics
      .map(toTopicInput)
      .filter((t) => !t.deferred)
      .map((t) => ({ ...t, classNumber: cls.number })),
  );
  const coveredNumbers = new Set(covered.map((c) => c.number));

  return {
    kind: "cumulative",
    course: {
      name: courseRow.name,
      persona: courseRow.persona,
      assessmentFormat: courseRow.assessmentFormat,
    },
    class: { id: highest.id, number: highest.number, title: highest.title },
    coveredClasses: covered.map((c) => ({ classNumber: c.number, title: c.title })),
    code,
    lessonMd: "",
    topics: [],
    earlierTopics,
    earlierLessons,
    backlog: loadBacklogWithDeferred(db, courseId).filter((b) => coveredNumbers.has(b.classNumber)),
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
