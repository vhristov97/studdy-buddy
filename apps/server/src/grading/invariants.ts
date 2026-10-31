import type { GradingItem, GradingResult } from "@studdy/shared";
import { answerOf, closedMisses } from "../agents/grader.js";
import type { GradingContext } from "./context.js";

const label = (item: Pick<GradingItem, "questionId" | "rowIndex">): string =>
  item.rowIndex === null ? item.questionId : `${item.questionId} row ${item.rowIndex}`;

/**
 * Re-checks the grading invariants against the automatic scoring (spec section 16), independent of
 * the agent's own schema checks: "Ne znam" (and an unanswered question) is never a misconception,
 * and a wrong answer is never a gap. Returns one message per violation.
 */
export function checkGradingInvariants(ctx: GradingContext, result: GradingResult): string[] {
  const questions = new Map(ctx.quiz.questions.map((q) => [q.id, q]));
  const statuses = new Map(ctx.submission.results.map((r) => [r.id, r.status]));
  const violations: string[] = [];

  for (const item of result.items) {
    const q = questions.get(item.questionId);
    if (!q) {
      violations.push(`${item.questionId} is not a question of the quiz`);
      continue;
    }
    const status = statuses.get(q.id) ?? "unanswered";

    if (item.classification === "gap" && item.misconception !== null) {
      violations.push(`${label(item)} is a gap but carries a misconception`);
    }

    if (q.type === "open") {
      if (status === "dont_know" || status === "unanswered") {
        if (item.classification !== "gap" || item.misconception !== null) {
          violations.push(`${label(item)} was "Ne znam" or unanswered but is not a plain gap`);
        }
      }
      continue;
    }

    const miss = closedMisses(q, answerOf(ctx, q.id), status).find(
      (m) => m.rowIndex === item.rowIndex,
    );
    if (!miss) {
      violations.push(`${label(item)} was answered correctly but has an item`);
    } else if (miss.kind === "gap") {
      if (item.classification !== "gap" || item.misconception !== null) {
        violations.push(`${label(item)} was "Ne znam" or unanswered but is not a plain gap`);
      }
    } else if (item.classification !== "misconception" || item.misconception === null) {
      violations.push(`${label(item)} was answered wrong but is not a misconception`);
    }
  }
  return violations;
}
