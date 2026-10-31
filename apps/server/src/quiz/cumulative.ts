import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { CumulativeScheduleEntry, CumulativeStatus } from "@studdy/shared";
import type { Db } from "../db/client.js";
import {
  classTable,
  course,
  generationJob,
  lesson,
  quiz,
  quizPlan,
  result,
  submission,
} from "../db/schema.js";
import { ConflictError } from "../repositories/conflict.js";
import { gradingStateOf } from "../repositories/grading.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

/** `K3` -> 3; null for any other code. */
export function parseCumulativeCode(code: string): number | null {
  const match = /^K(\d+)$/.exec(code);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export const cumulativeCode = (n: number): string => `K${n}`;

export interface ReadyClass {
  id: number;
  number: number;
  title: string;
}

/** Classes with a ready lesson, by class number. */
export function readyClasses(db: DbOrTx, courseId: number): ReadyClass[] {
  return db
    .select({ id: classTable.id, number: classTable.number, title: classTable.title })
    .from(classTable)
    .innerJoin(lesson, eq(lesson.classId, classTable.id))
    .where(and(eq(classTable.courseId, courseId), eq(classTable.status, "ready")))
    .orderBy(asc(classTable.number))
    .all();
}

function classNumberOf(db: DbOrTx, classId: number): number | undefined {
  return db
    .select({ number: classTable.number })
    .from(classTable)
    .where(eq(classTable.id, classId))
    .get()?.number;
}

interface ExistingCumulative {
  code: string;
  n: number;
  quizId: number;
  coversThrough: number;
}

/** The released cumulative quizzes of a course, by review number. */
function existingCumulatives(
  db: DbOrTx,
  courseId: number,
  ready: ReadyClass[],
): ExistingCumulative[] {
  const rows = db
    .select({ id: quiz.id, code: quiz.code, jobId: quiz.jobId })
    .from(quiz)
    .where(eq(quiz.courseId, courseId))
    .all();
  const found: ExistingCumulative[] = [];
  for (const row of rows) {
    const n = parseCumulativeCode(row.code);
    if (n === null) continue;
    // The generation job belongs to the highest class the review covers.
    const jobClass =
      row.jobId === null
        ? undefined
        : db
            .select({ classId: generationJob.classId })
            .from(generationJob)
            .where(eq(generationJob.id, row.jobId))
            .get()?.classId;
    let coversThrough = jobClass === undefined ? undefined : classNumberOf(db, jobClass);
    if (coversThrough === undefined) {
      const plan = db.select().from(quizPlan).where(eq(quizPlan.quizId, row.id)).get();
      const numbers = (plan?.planJson.questions ?? []).flatMap((q) =>
        q.classNumber === null ? [] : [q.classNumber],
      );
      coversThrough = numbers.length > 0 ? Math.max(...numbers) : (ready.at(-1)?.number ?? 0);
    }
    found.push({ code: row.code, n, quizId: row.id, coversThrough });
  }
  return found.sort((a, b) => a.n - b.n);
}

/** Review numbers `n` of the existing `K<n>` quizzes of a course (cheap: codes only). */
export function existingCumulativeNumbers(db: DbOrTx, courseId: number): Set<number> {
  const numbers = new Set<number>();
  for (const row of db
    .select({ code: quiz.code })
    .from(quiz)
    .where(eq(quiz.courseId, courseId))
    .all()) {
    const n = parseCumulativeCode(row.code);
    if (n !== null) numbers.add(n);
  }
  return numbers;
}

/**
 * The code of the next review: the smallest `K<n>` (n >= 1) with no released quiz in the course.
 * Codes stay gap-free and sequential; a failed (never released) review keeps its code for the retry.
 */
export function nextReviewCode(db: DbOrTx, courseId: number): string {
  const taken = existingCumulativeNumbers(db, courseId);
  let n = 1;
  while (taken.has(n)) n++;
  return cumulativeCode(n);
}

/**
 * The label for a gap found in class `classNumber`: the code of the review that will cover that
 * class. Positions count READY classes (class numbers may skip), the same way `cumulativeStatus`
 * schedules. With a cadence `c`, `L` = the highest class an existing review covers, `coveredCount`
 * = the ready classes up to `L` and `n0` = the number of the next unused code: a class whose
 * position is within `coveredCount` is covered history, so the next review (`K<n0>`) is the one that
 * covers it; a later class at position `p` lands in step `floor((p - coveredCount - 1) / c)` past
 * it (`K<n0 + step>`). A class that is not ready takes the position it would have. Without a
 * cadence it is always the next code. Informational only: a review's required items are decided by
 * coverage, never by this label.
 */
export function reviewCodeForClass(db: DbOrTx, courseId: number, classNumber: number): string {
  const nextCode = nextReviewCode(db, courseId);
  const cadence =
    db.select({ cadence: course.reviewCadence }).from(course).where(eq(course.id, courseId)).get()
      ?.cadence ?? null;
  if (cadence === null || cadence < 1) return nextCode;
  const ready = readyClasses(db, courseId);
  const last = Math.max(0, ...existingCumulatives(db, courseId, ready).map((e) => e.coversThrough));
  const coveredCount = ready.filter((c) => c.number <= last).length;
  const position = ready.filter((c) => c.number < classNumber).length + 1;
  if (position <= coveredCount) return nextCode;
  const step = Math.floor((position - coveredCount - 1) / cadence);
  return cumulativeCode(parseCumulativeCode(nextCode)! + step);
}

/**
 * The course's cumulative review state (spec §11). Coverage-based: `last` is the highest class
 * number any existing review covers; with a cadence a review is due once at least `cadence` ready
 * classes lie beyond it, whether earlier reviews were scheduled or requested by hand. It covers
 * every ready class up to one cadence step past `last` (further steps follow as their own reviews)
 * and gets the smallest unused `K<n>`. Without a cadence nothing is ever due (the student can still request one).
 */
export function cumulativeStatus(db: DbOrTx, courseId: number): CumulativeStatus {
  const cadence =
    db.select({ cadence: course.reviewCadence }).from(course).where(eq(course.id, courseId)).get()
      ?.cadence ?? null;
  const ready = readyClasses(db, courseId);
  const existing = existingCumulatives(db, courseId, ready);

  let due: CumulativeStatus["due"] = null;
  if (cadence !== null && cadence >= 1) {
    const last = Math.max(0, ...existing.map((e) => e.coversThrough));
    const coveredCount = ready.filter((c) => c.number <= last).length;
    const uncovered = ready.length - coveredCount;
    if (uncovered >= cadence) {
      const covered = ready.slice(0, coveredCount + cadence);
      due = {
        code: nextReviewCode(db, courseId),
        coversThrough: covered.at(-1)!.number,
        classNumbers: covered.map((c) => c.number),
      };
    }
  }
  return {
    cadence: cadence !== null && cadence >= 1 ? cadence : null,
    readyClassCount: ready.length,
    nextCode: nextReviewCode(db, courseId),
    due,
    existing: existing.map(({ code, quizId, coversThrough }) => ({ code, quizId, coversThrough })),
  };
}

/** What a request for a cumulative review resolves to. */
export interface CumulativeTarget {
  code: string;
  /** The highest covered class; a review covers every ready class up to and including it. */
  throughClass: ReadyClass;
  /** True when it is the review the cadence calls for. */
  due: boolean;
}

/**
 * Resolves a request: the review is always the next one (`nextReviewCode`); a given code must equal
 * it (this still allows retrying a failed review, whose code is unused). Throws `ConflictError`
 * when there is nothing to cover or the code is not the next one.
 */
export function resolveCumulativeTarget(
  db: DbOrTx,
  courseId: number,
  code?: string,
): CumulativeTarget {
  const status = cumulativeStatus(db, courseId);
  const ready = readyClasses(db, courseId);
  const last = ready.at(-1);
  if (!last) throw new ConflictError("No class has a finished lesson yet");

  const next = nextReviewCode(db, courseId);
  if (code !== undefined && code !== next) {
    throw new ConflictError(`Sledeći kumulativni test je ${next}`);
  }

  if (status.due && status.due.code === next) {
    const through = ready.find((c) => c.number === status.due!.coversThrough)!;
    return { code: next, throughClass: through, due: true };
  }
  return { code: next, throughClass: last, due: false };
}

/** Rows of the cumulative test schedule: every released review plus the due and the building ones. */
export function cumulativeSchedule(db: Db, courseId: number): CumulativeScheduleEntry[] {
  const status = cumulativeStatus(db, courseId);
  const rows = new Map<number, CumulativeScheduleEntry>();

  for (const e of status.existing) {
    const n = parseCumulativeCode(e.code)!;
    const latest = db
      .select({ id: submission.id, submittedAt: submission.submittedAt })
      .from(submission)
      .where(eq(submission.quizId, e.quizId))
      .orderBy(desc(submission.id))
      .limit(1)
      .get();
    const graded = latest
      ? db
          .select({ totalScore: result.totalScore })
          .from(result)
          .where(eq(result.submissionId, latest.id))
          .get()
      : undefined;
    const gradingFailed = latest && !graded && gradingStateOf(db, latest.id).status === "failed";
    rows.set(n, {
      code: e.code,
      coversThrough: e.coversThrough,
      status: graded
        ? "graded"
        : gradingFailed
          ? "grading_failed"
          : latest
            ? "submitted"
            : "available",
      quizId: e.quizId,
      submissionId: gradingFailed ? latest.id : null,
      submittedAt: latest?.submittedAt.toISOString() ?? null,
      totalScore: graded?.totalScore ?? null,
    });
  }

  // Running builds; a due review with no running job is simply due.
  const running = db
    .select({ code: generationJob.quizCode, classId: generationJob.classId })
    .from(generationJob)
    .innerJoin(classTable, eq(classTable.id, generationJob.classId))
    .where(
      and(
        eq(classTable.courseId, courseId),
        eq(generationJob.kind, "quiz"),
        eq(generationJob.status, "running"),
        isNotNull(generationJob.quizCode),
      ),
    )
    .all();
  const building = new Map<string, number>();
  for (const job of running) {
    const number = classNumberOf(db, job.classId);
    if (job.code !== null && number !== undefined) building.set(job.code, number);
  }
  for (const [code, coversThrough] of building) {
    const n = parseCumulativeCode(code);
    if (n === null || rows.has(n)) continue;
    rows.set(n, {
      code,
      coversThrough,
      status: "building",
      quizId: null,
      submissionId: null,
      submittedAt: null,
      totalScore: null,
    });
  }
  if (status.due) {
    const n = parseCumulativeCode(status.due.code)!;
    if (!rows.has(n)) {
      rows.set(n, {
        code: status.due.code,
        coversThrough: status.due.coversThrough,
        status: "due",
        quizId: null,
        submissionId: null,
        submittedAt: null,
        totalScore: null,
      });
    }
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}
