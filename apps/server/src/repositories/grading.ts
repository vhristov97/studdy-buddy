import { desc, eq } from "drizzle-orm";
import type { GradingStatus, SubmissionGrading, SubmissionGradingResult } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { generationJob, result } from "../db/schema.js";

/** The latest grading job of a submission, if any. */
export function latestGradingJob(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  submissionId: number,
): typeof generationJob.$inferSelect | undefined {
  return db
    .select()
    .from(generationJob)
    .where(eq(generationJob.submissionId, submissionId))
    .orderBy(desc(generationJob.id))
    .limit(1)
    .get();
}

/** `done` once a result exists; otherwise the state of the latest grading job. */
export function gradingStateOf(
  db: Db,
  submissionId: number,
): { status: GradingStatus; error: string | null } {
  const hasResult = db
    .select({ id: result.id })
    .from(result)
    .where(eq(result.submissionId, submissionId))
    .get();
  if (hasResult) return { status: "done", error: null };
  const job = latestGradingJob(db, submissionId);
  if (job?.status === "running") return { status: "running", error: null };
  if (job?.status === "failed") return { status: "failed", error: job.error };
  return { status: "none", error: null };
}

/** The grading block of a submission's detail. */
export function getSubmissionGrading(db: Db, submissionId: number): SubmissionGrading {
  const state = gradingStateOf(db, submissionId);
  if (state.status !== "done") return { ...state, result: null };
  const row = db.select().from(result).where(eq(result.submissionId, submissionId)).get()!;
  const graded: SubmissionGradingResult = {
    openGrades: row.resultJson.openGrades,
    items: row.resultJson.items,
    correctFixes: row.resultJson.correctFixes,
    topicUpdates: row.resultJson.topicUpdates,
    writeupMd: row.writeupMd,
    openScore: row.openScore,
    totalScore: row.totalScore,
    gradedAt: row.createdAt.toISOString(),
  };
  return { status: "done", error: null, result: graded };
}
