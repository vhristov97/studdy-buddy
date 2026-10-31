import { asc, count, desc, eq, getTableColumns, max, sql } from "drizzle-orm";
import type {
  ClassDetail,
  ClassSummary,
  CourseDetail,
  CourseSummary,
  CreateClassInput,
  CreateCourseInput,
  UpdateClassInput,
  UpdateCourseInput,
} from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable, course, material } from "../db/schema.js";
import { ConflictError, isUniqueViolation } from "./conflict.js";
import { listMaterials } from "./materials.js";

function classNumberConflict(number: number): ConflictError {
  return new ConflictError(`Class number ${number} already exists in this course`);
}

type CourseRow = typeof course.$inferSelect;
type ClassRow = typeof classTable.$inferSelect;

function toCourseSummary(row: CourseRow, classCount: number): CourseSummary {
  return {
    id: row.id,
    name: row.name,
    persona: row.persona,
    assessmentFormat: row.assessmentFormat,
    reviewCadence: row.reviewCadence,
    classCount,
    createdAt: row.createdAt.toISOString(),
  };
}

interface ClassCounts {
  materialCount: number;
  noteCount: number;
}

function toClassSummary(row: ClassRow, counts: ClassCounts): ClassSummary {
  return {
    id: row.id,
    courseId: row.courseId,
    number: row.number,
    title: row.title,
    status: row.status,
    materialCount: counts.materialCount,
    noteCount: counts.noteCount,
    createdAt: row.createdAt.toISOString(),
  };
}

const NO_FILES: ClassCounts = { materialCount: 0, noteCount: 0 };

/** Classes with their file counts, in one grouped query. */
function selectClassSummaries(db: Db) {
  return db
    .select({
      ...getTableColumns(classTable),
      materialCount:
        sql<number>`coalesce(sum(case when ${material.kind} = 'material' then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      noteCount:
        sql<number>`coalesce(sum(case when ${material.kind} = 'note' then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
    })
    .from(classTable)
    .leftJoin(material, eq(material.classId, classTable.id))
    .groupBy(classTable.id);
}

function getClassSummary(db: Db, id: number): ClassSummary | undefined {
  const row = selectClassSummaries(db).where(eq(classTable.id, id)).get();
  return row && toClassSummary(row, row);
}

function selectCourseSummaries(db: Db) {
  return db
    .select({ ...getTableColumns(course), classCount: count(classTable.id) })
    .from(course)
    .leftJoin(classTable, eq(classTable.courseId, course.id))
    .groupBy(course.id);
}

function getCourseSummary(db: Db, id: number): CourseSummary | undefined {
  const row = selectCourseSummaries(db).where(eq(course.id, id)).get();
  return row && toCourseSummary(row, row.classCount);
}

// Courses

/** Newest first. */
export function listCourses(db: Db): CourseSummary[] {
  return selectCourseSummaries(db)
    .orderBy(desc(course.createdAt), desc(course.id))
    .all()
    .map((row) => toCourseSummary(row, row.classCount));
}

export function getCourse(db: Db, id: number): CourseDetail | undefined {
  const summary = getCourseSummary(db, id);
  if (!summary) return undefined;
  const classes = selectClassSummaries(db)
    .where(eq(classTable.courseId, id))
    .orderBy(asc(classTable.number))
    .all()
    .map((row) => toClassSummary(row, row));
  return { ...summary, classes };
}

export function createCourse(db: Db, input: CreateCourseInput): CourseSummary {
  const row = db
    .insert(course)
    .values({
      name: input.name,
      persona: input.persona ?? null,
      assessmentFormat: input.assessmentFormat ?? null,
      reviewCadence: input.reviewCadence ?? null,
    })
    .returning()
    .get();
  return toCourseSummary(row, 0);
}

export function updateCourse(
  db: Db,
  id: number,
  input: UpdateCourseInput,
): CourseSummary | undefined {
  // Undefined fields are left untouched; null clears an optional field.
  db.update(course)
    .set({
      name: input.name,
      persona: input.persona,
      assessmentFormat: input.assessmentFormat,
      reviewCadence: input.reviewCadence,
    })
    .where(eq(course.id, id))
    .run();
  return getCourseSummary(db, id);
}

/** Cascades to the course's classes. Returns false if the course does not exist. */
export function deleteCourse(db: Db, id: number): boolean {
  return db.delete(course).where(eq(course.id, id)).run().changes > 0;
}

// Classes

/** Returns undefined if the course does not exist. The number defaults to max + 1. */
export function createClass(
  db: Db,
  courseId: number,
  input: CreateClassInput,
): ClassSummary | undefined {
  try {
    return db.transaction((tx) => {
      const exists = tx.select({ id: course.id }).from(course).where(eq(course.id, courseId)).get();
      if (!exists) return undefined;
      let number = input.number;
      if (number === undefined) {
        const row = tx
          .select({ highest: max(classTable.number) })
          .from(classTable)
          .where(eq(classTable.courseId, courseId))
          .get();
        number = (row?.highest ?? 0) + 1;
      }
      const created = tx
        .insert(classTable)
        .values({ courseId, number, title: input.title })
        .returning()
        .get();
      return toClassSummary(created, NO_FILES);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw classNumberConflict(input.number ?? 0);
    throw err;
  }
}

export function getClass(db: Db, id: number): ClassDetail | undefined {
  const summary = getClassSummary(db, id);
  if (!summary) return undefined;
  const owner = db
    .select({ name: course.name })
    .from(course)
    .where(eq(course.id, summary.courseId))
    .get();
  if (!owner) return undefined;
  return { ...summary, courseName: owner.name, materials: listMaterials(db, id) };
}

export function updateClass(db: Db, id: number, input: UpdateClassInput): ClassSummary | undefined {
  try {
    const { changes } = db
      .update(classTable)
      .set({ title: input.title, number: input.number })
      .where(eq(classTable.id, id))
      .run();
    return changes > 0 ? getClassSummary(db, id) : undefined;
  } catch (err) {
    if (isUniqueViolation(err)) throw classNumberConflict(input.number ?? 0);
    throw err;
  }
}

/** Returns false if the class does not exist. */
export function deleteClass(db: Db, id: number): boolean {
  return db.delete(classTable).where(eq(classTable.id, id)).run().changes > 0;
}
