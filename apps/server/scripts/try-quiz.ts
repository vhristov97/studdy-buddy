/**
 * Manual check of the quiz agents on a real class from the app DB: planner -> builder (one
 * session) -> reviewer, once, with no fix loop. Calls the paid Anthropic API.
 *
 *   npm run quiz:try -- --class <id>
 *
 * Writes <DATA_DIR>/tmp/quiz-<id>.plan.json, .quiz.json and .review.json.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatQuizReport, validateQuiz } from "@studdy/shared";
import type { SemanticEvent } from "@mozaik-ai/core";
import { buildQuizBuilderMessage, openQuizBuilderSession } from "../src/agents/quiz-builder.js";
import { planQuiz } from "../src/agents/quiz-planner.js";
import { reviewQuiz } from "../src/agents/quiz-reviewer.js";
import { initAgentRuntime, warnIfTelemetryOn } from "../src/agents/runtime.js";
import { StageError } from "../src/agents/stage.js";
import { config } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { loadQuizContext, notesMisconceptions, type QuizContext } from "../src/quiz/context.js";

const { values } = parseArgs({ options: { class: { type: "string" } }, allowPositionals: false });

const classId = Number(values.class);
if (!values.class || !Number.isInteger(classId) || classId <= 0) {
  console.error("Usage: npm run quiz:try -- --class <id>");
  process.exit(2);
}
if (!config.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to the repo-root .env and run again.");
  process.exit(1);
}

const { db, close } = openDatabase(config.DATA_DIR);
let ctx: QuizContext;
try {
  ctx = loadQuizContext(db, classId);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Database: ${path.join(config.DATA_DIR, "app.sqlite")}`);
  close();
  process.exit(1);
}
close();

console.log(
  `Course "${ctx.course.name}", class ${ctx.class.number} "${ctx.class.title}" (${ctx.code}): ` +
    `${ctx.topics.length} topics, ${ctx.earlierTopics.length} earlier weak topic(s). ` +
    `Planner ${config.MODEL_PLANNER}, builder ${config.MODEL_BUILDER}.`,
);

const logger = {
  warn(obj: object, msg: string): void {
    console.warn(`\n[runner warn] ${msg}`, obj);
  },
};
initAgentRuntime({ logger });
warnIfTelemetryOn(logger);

let streamEvents = 0;
const onEvent = (event: SemanticEvent): void => {
  if (event.type === "inference.stream" && ++streamEvents % 50 === 0) process.stdout.write(".");
};

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  streamEvents = 0;
  process.stdout.write(`${label} `);
  const started = performance.now();
  const result = await run();
  console.log(` ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return result;
}

const started = performance.now();
try {
  const plan = await timed("Planning", () => planQuiz(ctx, { onEvent }));

  const session = openQuizBuilderSession(plan, { onEvent });
  const draft = await timed("Building", () =>
    session
      .send(
        buildQuizBuilderMessage({
          plan,
          lessonMd: ctx.lessonMd,
          notesMisconceptions: notesMisconceptions(ctx),
          earlierLessons: ctx.earlierLessons,
        }),
      )
      .finally(() => session.close()),
  );

  const report = validateQuiz(draft.quiz);
  const review = await timed("Reviewing", () =>
    reviewQuiz(
      {
        plan,
        quiz: draft.quiz,
        flags: draft.flags,
        lessonMd: ctx.lessonMd,
        earlierLessons: ctx.earlierLessons,
        report,
      },
      { onEvent },
    ),
  );

  const outDir = path.join(config.DATA_DIR, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const write = (suffix: string, value: unknown): string => {
    const file = path.join(outDir, `quiz-${classId}.${suffix}.json`);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };
  const files = [
    write("plan", plan),
    write("quiz", { quiz: draft.quiz, flags: draft.flags }),
    write("review", review),
  ];

  console.log(`\nTotal ${((performance.now() - started) / 1000).toFixed(1)}s.`);
  console.log(
    `Plan: ${plan.questions.length} questions, mix ${JSON.stringify(plan.typeMix)}, ` +
      `~${plan.targetMinutes} min, ${plan.leftOut.length} topic(s) left out.`,
  );
  console.log(`Builder flags: ${draft.flags.length}`);
  console.log(`\nValidator report:\n${formatQuizReport(report)}`);
  console.log(
    `\nReview: ${review.approved ? "APPROVED" : `NOT approved, ${review.fixes.length} fix(es)`}`,
  );
  console.log(`  ${review.summary}`);
  for (const f of review.fixes) console.log(`  - ${f.questionId}: ${f.problem}`);
  console.log(`\nFiles:\n${files.map((f) => `  ${f}`).join("\n")}`);
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
