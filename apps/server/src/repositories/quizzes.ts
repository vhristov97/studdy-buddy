import { desc, eq } from "drizzle-orm";
import type { QuizSummary } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { quiz } from "../db/schema.js";

/** Released quizzes of a course, newest first. Neither questions nor plans are included. */
export function listQuizSummaries(db: Db, courseId: number): QuizSummary[] {
  return db
    .select()
    .from(quiz)
    .where(eq(quiz.courseId, courseId))
    .orderBy(desc(quiz.id))
    .all()
    .map((row) => ({
      id: row.id,
      courseId: row.courseId,
      classId: row.classId,
      code: row.code,
      title: row.title,
      subtitle: row.subtitle,
      chips: row.chipsJson,
      questionCount: row.questionsJson.length,
      createdAt: row.createdAt.toISOString(),
    }));
}
