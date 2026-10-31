import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CLASS_STATUSES } from "@studdy/shared";

/** Placeholder table; real tables arrive in later tasks. */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);

export const course = sqliteTable("course", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  persona: text("persona"),
  assessmentFormat: text("assessment_format"),
  /** A cumulative review every N classes. */
  reviewCadence: integer("review_cadence"),
  createdAt: createdAt(),
});

export const classTable = sqliteTable(
  "class",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    courseId: integer("course_id")
      .notNull()
      .references(() => course.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: CLASS_STATUSES }).notNull().default("draft"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("class_course_id_number_unique").on(table.courseId, table.number),
    index("class_course_id_idx").on(table.courseId),
  ],
);
