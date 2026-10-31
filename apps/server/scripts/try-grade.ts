/**
 * Manual check of the grader on a real submission from the app DB. Calls the paid Anthropic API.
 *
 *   npm run grade:try -- --submission <id>
 *
 * Writes <DATA_DIR>/tmp/grade-<id>.json (the grading result) and grade-<id>.writeup.md.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SemanticEvent } from "@mozaik-ai/core";
import { gradeSubmission } from "../src/agents/grader.js";
import { initAgentRuntime } from "../src/agents/runtime.js";
import { StageError } from "../src/agents/stage.js";
import { config } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { loadGradingContext, type GradingContext } from "../src/grading/context.js";

const { values } = parseArgs({
  options: { submission: { type: "string" } },
  allowPositionals: false,
});

const submissionId = Number(values.submission);
if (!values.submission || !Number.isInteger(submissionId) || submissionId <= 0) {
  console.error("Usage: npm run grade:try -- --submission <id>");
  process.exit(2);
}
if (!config.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to the repo-root .env and run again.");
  process.exit(1);
}

const { db, close } = openDatabase(config.DATA_DIR);
let ctx: GradingContext;
try {
  ctx = loadGradingContext(db, submissionId);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Database: ${path.join(config.DATA_DIR, "app.sqlite")}`);
  close();
  process.exit(1);
}
close();

console.log(
  `Course "${ctx.course.name}", quiz ${ctx.quiz.code} (${ctx.quiz.questions.length} questions), ` +
    `submission ${ctx.submission.id}: auto ${ctx.submission.autoScore}/${ctx.submission.autoMax}, ` +
    `${ctx.topics.length} topic(s), ${ctx.lessons.length} lesson(s), next cumulative ` +
    `${ctx.nextCumulativeCode}. Grader ${config.MODEL_PLANNER}.`,
);

initAgentRuntime({
  logger: {
    warn(obj: object, msg: string): void {
      console.warn(`\n[runner warn] ${msg}`, obj);
    },
  },
});

let streamEvents = 0;
const onEvent = (event: SemanticEvent): void => {
  if (event.type === "inference.stream" && ++streamEvents % 50 === 0) process.stdout.write(".");
};

const started = performance.now();
process.stdout.write("Grading ");
try {
  const result = await gradeSubmission(ctx, { onEvent });
  console.log(` ${((performance.now() - started) / 1000).toFixed(1)}s`);

  const outDir = path.join(config.DATA_DIR, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, `grade-${submissionId}.json`);
  const mdFile = path.join(outDir, `grade-${submissionId}.writeup.md`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(mdFile, `${result.writeupMd}\n`);

  const counts = { gap: 0, misconception: 0, partial: 0 };
  for (const item of result.items) counts[item.classification]++;
  console.log(
    `\nAuto check: ${result.autoCheck.agrees ? "agrees" : `DISAGREES: ${result.autoCheck.note}`}`,
  );
  console.log("Open grades:");
  for (const g of result.openGrades) console.log(`  ${g.questionId}: ${g.score}`);
  if (result.openGrades.length === 0) console.log("  (none)");
  console.log(
    `Items: ${result.items.length} (gap ${counts.gap}, misconception ${counts.misconception}, partial ${counts.partial})`,
  );
  console.log(`Fixed notes misconceptions: ${result.correctFixes.length}`);
  console.log("Topic updates:");
  for (const u of result.topicUpdates) {
    console.log(`  ${u.rating} ${u.topic} (predavanje ${u.classNumber}): ${u.note}`);
  }
  console.log(
    `Backlog: +${result.backlogAdd.length} (${result.backlogAdd.map((b) => `${b.topic}/${b.reason}`).join(", ")}), ` +
      `-${result.backlogResolve.length}`,
  );
  console.log(`New observations: ${result.observations.length}`);
  for (const o of result.observations) console.log(`  - ${o}`);
  console.log("Next steps:");
  result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`\nFiles:\n  ${jsonFile}\n  ${mdFile}`);
  process.exit(0);
} catch (error) {
  console.error(`\nFAILED after ${((performance.now() - started) / 1000).toFixed(1)}s:`);
  if (error instanceof StageError) {
    console.error(`  [${error.kind}] ${error.message}`);
    if (error.rawText !== undefined) {
      const raw = error.rawText;
      console.error(`  rawText: ${raw.length > 800 ? `${raw.slice(0, 800)}...` : raw}`);
    }
  } else {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
