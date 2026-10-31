import { desc, eq } from "drizzle-orm";
import {
  toPublicQuestion,
  type PublicQuiz,
  type Quiz,
  type QuizSummary,
  type SubmissionAnswers,
  type SubmissionDetail,
  type SubmissionSummary,
  type QuizScore,
  toFeedback,
} from "@studdy/shared";
import type { Db } from "../db/client.js";
import { course, quiz, submission } from "../db/schema.js";

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

type QuizRow = typeof quiz.$inferSelect;
type SubmissionRow = typeof submission.$inferSelect;

/** The full quiz including answers. Server-side only: scoring and feedback. */
export function getFullQuiz(db: Db, quizId: number): { row: QuizRow; quiz: Quiz } | undefined {
  const row = db.select().from(quiz).where(eq(quiz.id, quizId)).get();
  if (!row) return undefined;
  return {
    row,
    quiz: {
      code: row.code,
      title: row.title,
      subtitle: row.subtitle,
      chips: row.chipsJson,
      questions: row.questionsJson,
    },
  };
}

/** The quiz as the student sees it before submitting: no answers, explanations or key points. */
export function getPublicQuiz(db: Db, quizId: number): PublicQuiz | undefined {
  const row = db
    .select({ quiz, courseName: course.name })
    .from(quiz)
    .innerJoin(course, eq(course.id, quiz.courseId))
    .where(eq(quiz.id, quizId))
    .get();
  if (!row) return undefined;
  return {
    id: row.quiz.id,
    courseId: row.quiz.courseId,
    courseName: row.courseName,
    classId: row.quiz.classId,
    code: row.quiz.code,
    title: row.quiz.title,
    subtitle: row.quiz.subtitle,
    chips: [...row.quiz.chipsJson],
    createdAt: row.quiz.createdAt.toISOString(),
    questions: row.quiz.questionsJson.map(toPublicQuestion),
  };
}

function toSubmissionSummary(row: SubmissionRow): SubmissionSummary {
  return {
    id: row.id,
    quizId: row.quizId,
    autoScore: row.autoScore,
    autoMax: row.autoMax,
    openPending: row.openPending,
    dontKnow: row.dontKnowJson,
    submittedAt: row.submittedAt.toISOString(),
  };
}

function toSubmissionDetail(row: SubmissionRow, fullQuiz: Quiz): SubmissionDetail {
  return {
    ...toSubmissionSummary(row),
    answers: row.answersJson,
    results: row.resultsJson,
    feedback: toFeedback(fullQuiz),
  };
}

export function createSubmission(
  db: Db,
  quizId: number,
  fullQuiz: Quiz,
  answers: SubmissionAnswers,
  score: QuizScore,
): SubmissionDetail {
  const row = db
    .insert(submission)
    .values({
      quizId,
      answersJson: answers,
      autoScore: score.autoScore,
      autoMax: score.autoMax,
      dontKnowJson: score.dontKnow,
      resultsJson: score.results,
      openPending: score.openPending,
    })
    .returning()
    .get();
  return toSubmissionDetail(row, fullQuiz);
}

/** Submissions of a quiz, newest first. */
export function listSubmissions(db: Db, quizId: number): SubmissionSummary[] {
  return db
    .select()
    .from(submission)
    .where(eq(submission.quizId, quizId))
    .orderBy(desc(submission.id))
    .all()
    .map(toSubmissionSummary);
}

export function getSubmissionDetail(db: Db, submissionId: number): SubmissionDetail | undefined {
  const row = db.select().from(submission).where(eq(submission.id, submissionId)).get();
  if (!row) return undefined;
  const full = getFullQuiz(db, row.quizId);
  return full ? toSubmissionDetail(row, full.quiz) : undefined;
}
