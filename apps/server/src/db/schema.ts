import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import {
  CLASS_STATUSES,
  EXTRACTION_STATUSES,
  JOB_KINDS,
  JOB_STATUSES,
  MATERIAL_KINDS,
  TOPIC_EVENT_SOURCES,
  TOPIC_RATINGS,
  VIZ_SUGGESTION_ORIGINS,
  type QuizDraftFlag,
  type QuizPlan,
  type QuizReport,
  type QuizReview,
  type Question,
  type QuestionResult,
  type SubmissionAnswers,
} from "@studdy/shared";

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

export const generationJob = sqliteTable(
  "generation_job",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    classId: integer("class_id")
      .notNull()
      .references(() => classTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    /** Pipeline stage, e.g. `lesson-writer`. */
    stage: text("stage").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull(),
    /** 1 for the first run, +1 per retry after a failure. */
    attempt: integer("attempt").notNull(),
    error: text("error"),
    /** Review cycle (from 1) of a quiz job; null otherwise. */
    cycle: integer("cycle"),
    /** The failed job this one retries. */
    parentJobId: integer("parent_job_id").references((): AnySQLiteColumn => generationJob.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("generation_job_class_id_idx").on(table.classId)],
);

export const lesson = sqliteTable("lesson", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  classId: integer("class_id")
    .notNull()
    .unique()
    .references(() => classTable.id, { onDelete: "cascade" }),
  bodyMd: text("body_md").notNull(),
  createdAt: createdAt(),
});

export const topic = sqliteTable(
  "topic",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    courseId: integer("course_id")
      .notNull()
      .references(() => course.id, { onDelete: "cascade" }),
    classId: integer("class_id")
      .notNull()
      .references(() => classTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Order in the lesson, from 0. */
    position: integer("position").notNull(),
    rating: text("rating", { enum: TOPIC_RATINGS }).notNull().default("?"),
    deferred: integer("deferred", { mode: "boolean" }).notNull().default(false),
    deferredNote: text("deferred_note"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("topic_class_id_name_unique").on(table.classId, table.name),
    index("topic_course_id_idx").on(table.courseId),
  ],
);

export const topicEvent = sqliteTable(
  "topic_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topic.id, { onDelete: "cascade" }),
    source: text("source", { enum: TOPIC_EVENT_SOURCES }).notNull(),
    /** E.g. a quiz code. */
    ref: text("ref"),
    outcome: text("outcome"),
    misconceptionText: text("misconception_text"),
    correctionText: text("correction_text"),
    createdAt: createdAt(),
  },
  (table) => [index("topic_event_topic_id_idx").on(table.topicId)],
);

/** Immutable once inserted. The full questions (answers included) stay on the server for now. */
export const quiz = sqliteTable(
  "quiz",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    courseId: integer("course_id")
      .notNull()
      .references(() => course.id, { onDelete: "cascade" }),
    /** Null for cumulative (K) quizzes, which belong to no single class. */
    classId: integer("class_id").references(() => classTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle").notNull(),
    chipsJson: text("chips_json", { mode: "json" }).$type<string[]>().notNull(),
    questionsJson: text("questions_json", { mode: "json" }).$type<Question[]>().notNull(),
    jobId: integer("job_id").references(() => generationJob.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("quiz_course_id_code_unique").on(table.courseId, table.code),
    index("quiz_class_id_idx").on(table.classId),
  ],
);

/** One entry per review cycle of a quiz job. */
export interface QuizPlanLogEntry {
  cycle: number;
  report: QuizReport;
  /** Null while the review runs, or when it failed. */
  review: QuizReview | null;
  flags: QuizDraftFlag[];
}

/** The planner's answer key and the build/review history. Never exposed by any route. */
export const quizPlan = sqliteTable("quiz_plan", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .unique()
    .references(() => generationJob.id, { onDelete: "cascade" }),
  classId: integer("class_id")
    .notNull()
    .references(() => classTable.id, { onDelete: "cascade" }),
  planJson: text("plan_json", { mode: "json" }).$type<QuizPlan>().notNull(),
  /** The latest builder draft. */
  draftJson: text("draft_json", { mode: "json" }).$type<unknown>(),
  logJson: text("log_json", { mode: "json" }).$type<QuizPlanLogEntry[]>().notNull(),
  quizId: integer("quiz_id").references(() => quiz.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** A student's attempt at a quiz. Scored on the server when it is created; immutable afterwards. */
export const submission = sqliteTable(
  "submission",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quizId: integer("quiz_id")
      .notNull()
      .references(() => quiz.id, { onDelete: "cascade" }),
    answersJson: text("answers_json", { mode: "json" }).$type<SubmissionAnswers>().notNull(),
    autoScore: real("auto_score").notNull(),
    autoMax: integer("auto_max").notNull(),
    /** "q3" or "q14.r2" ids. */
    dontKnowJson: text("dont_know_json", { mode: "json" }).$type<string[]>().notNull(),
    resultsJson: text("results_json", { mode: "json" }).$type<QuestionResult[]>().notNull(),
    openPending: integer("open_pending").notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [index("submission_quiz_id_idx").on(table.quizId)],
);

/** A visualization topic for a class: recommended by the viz-identifier agent or added by the student. */
export const vizSuggestion = sqliteTable(
  "viz_suggestion",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    classId: integer("class_id")
      .notNull()
      .references(() => classTable.id, { onDelete: "cascade" }),
    concept: text("concept").notNull(),
    /** Lesson section path; empty for a user topic. */
    section: text("section").notNull(),
    misconception: text("misconception").notNull(),
    summary: text("summary").notNull(),
    controlsJson: text("controls_json", { mode: "json" }).$type<string[]>().notNull(),
    scenariosJson: text("scenarios_json", { mode: "json" }).$type<string[]>().notNull(),
    origin: text("origin", { enum: VIZ_SUGGESTION_ORIGINS }).notNull(),
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    /** The `viz_topics` job that produced it (agent suggestions only). */
    jobId: integer("job_id").references(() => generationJob.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("viz_suggestion_class_id_idx").on(table.classId)],
);
