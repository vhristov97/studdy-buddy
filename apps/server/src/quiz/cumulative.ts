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

/** The ready classes a review `K<n>` of this cadence covers: the first n * cadence of them. */
function dueClasses(ready: ReadyClass[], n: number, cadence: number): ReadyClass[] {
  return ready.slice(0, n * cadence);
}

/**
 * The course's cumulative review state (spec §11): `K<n>` is due once n * cadence classes have a
 * ready lesson and no quiz `K<n>` exists; the earliest missing `n` wins. Without a cadence nothing
 * is ever due (the student can still request one).
 */
export function cumulativeStatus(db: DbOrTx, courseId: number): CumulativeStatus {
  const cadence =
    db.select({ cadence: course.reviewCadence }).from(course).where(eq(course.id, courseId)).get()
      ?.cadence ?? null;
  const ready = readyClasses(db, courseId);
  const existing = existingCumulatives(db, courseId, ready);
  const taken = new Set(existing.map((e) => e.n));

  let due: CumulativeStatus["due"] = null;
  if (cadence !== null && cadence >= 1) {
    for (let n = 1; n * cadence <= ready.length; n++) {
      if (taken.has(n)) continue;
      const covered = dueClasses(ready, n, cadence);
      due = {
        code: cumulativeCode(n),
        coversThrough: covered.at(-1)!.number,
        classNumbers: covered.map((c) => c.number),
      };
      break;
    }
  }
  return {
    cadence: cadence !== null && cadence >= 1 ? cadence : null,
    readyClassCount: ready.length,
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
 * Resolves a request: the given code (or, without one, the due review, or else the smallest free
 * review number covering all ready classes). Throws `ConflictError` when there is nothing to cover
 * or the review already exists.
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
  const taken = new Set(status.existing.map((e) => parseCumulativeCode(e.code)));

  let requested = code;
  if (requested === undefined) {
    if (status.due) requested = status.due.code;
    else {
      let n = 1;
      while (taken.has(n)) n++;
      requested = cumulativeCode(n);
    }
  }
  const n = parseCumulativeCode(requested);
  if (n === null) throw new ConflictError(`"${requested}" is not a cumulative review code`);
  if (taken.has(n)) throw new ConflictError(`The review ${requested} already exists`);

  if (status.due && status.due.code === requested) {
    const through = ready.find((c) => c.number === status.due!.coversThrough)!;
    return { code: requested, throughClass: through, due: true };
  }
  return { code: requested, throughClass: last, due: false };
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
    rows.set(n, {
      code: e.code,
      coversThrough: e.coversThrough,
      status: graded ? "graded" : latest ? "submitted" : "available",
      quizId: e.quizId,
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
        submittedAt: null,
        totalScore: null,
      });
    }
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}
