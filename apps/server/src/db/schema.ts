import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { CLASS_STATUSES, EXTRACTION_STATUSES, MATERIAL_KINDS } from "@studdy/shared";

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

export const material = sqliteTable(
  "material",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    classId: integer("class_id")
      .notNull()
      .references(() => classTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MATERIAL_KINDS }).notNull(),
    originalName: text("original_name").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Relative to DATA_DIR, e.g. `files/ab/<sha256>.pdf`. */
    storagePath: text("storage_path").notNull(),
    extractedText: text("extracted_text"),
    extractionStatus: text("extraction_status", { enum: EXTRACTION_STATUSES }).notNull(),
    extractionError: text("extraction_error"),
    pageCount: integer("page_count"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("material_class_id_sha256_unique").on(table.classId, table.sha256),
    index("material_class_id_idx").on(table.classId),
    index("material_sha256_idx").on(table.sha256),
  ],
);
