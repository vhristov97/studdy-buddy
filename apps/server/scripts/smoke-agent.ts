/**
 * Manual smoke test for the agent stack: Mozaik 4.1.0 + stage helper + Anthropic strict
 * structured output, on every configured model. Calls the paid Anthropic API.
 *
 *   npm run smoke:agent [-- --model <id>] [-- --step a|b|c]
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { config } from "../src/config.js";
import { initAgentRuntime, warnIfTelemetryOn } from "../src/agents/runtime.js";
import { StageError, openStageSession, runStage, type StageSpec } from "../src/agents/stage.js";

const STEPS = ["a", "b", "c"] as const;
type Step = (typeof STEPS)[number];

const STEP_LABELS: Record<Step, string> = {
  a: "a) streaming runStage",
  b: "b) non-streaming runStage",
  c: "c) 2-turn session",
};

const quizItemSchema = z.object({
  topic: z.string(),
  difficulty: z.number(),
  isCore: z.boolean(),
  questionType: z.enum(["mc", "num", "match", "open"]),
  hint: z.string().nullable(),
  items: z.array(z.object({ term: z.string(), definition: z.string() })),
});
type QuizItem = z.infer<typeof quizItemSchema>;

const INSTRUCTION =
  "Ti si tutor za distribuirane sisteme. Odgovaraj na srpskom jeziku, kratko. " +
  "Vrati samo JSON koji odgovara zadatoj šemi.";

function baseSpec(name: string, model: string): StageSpec<QuizItem> {
  return {
    name,
    instruction: INSTRUCTION,
    model,
    schema: quizItemSchema,
    schemaName: "quiz_item",
    maxOutputTokens: 2000,
  };
}

interface Result {
  model: string;
  step: Step;
  ok: boolean;
  seconds: number;
}

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    step: { type: "string" },
  },
  allowPositionals: false,
});

if (values.step !== undefined && !STEPS.includes(values.step as Step)) {
  console.error(`Invalid --step "${values.step}"; expected one of: ${STEPS.join(", ")}.`);
  process.exit(2);
}
const onlyStep = values.step as Step | undefined;

if (!config.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to the repo-root .env and run again.");
  process.exit(1);
}

const logger = {
  warn(obj: object, msg: string): void {
    console.warn(`[runner warn] ${msg}`, obj);
  },
};
initAgentRuntime({ logger });
warnIfTelemetryOn(logger);

const models = values.model
  ? [values.model]
  : [...new Set([config.MODEL_PLANNER, config.MODEL_BUILDER])];
const steps = onlyStep ? [onlyStep] : [...STEPS];

function printJson(label: string, value: unknown, seconds: number): void {
  console.log(`  ${label} (${seconds.toFixed(1)}s):`);
  console.log(
    JSON.stringify(value, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );
}

async function stepA(model: string): Promise<void> {
  let streamEvents = 0;
  const started = performance.now();
  const result = await runStage(
    {
      ...baseSpec("smoke-a", model),
      onEvent: (event) => {
        if (event.type === "inference.stream") streamEvents++;
      },
    },
    "Napravi jednu kviz stavku o shardingu (topic, difficulty 1-5, isCore, questionType, " +
      'hint: null) sa tačno 2 elementa u "items" (term + definition).',
  );
  printJson("result", result, (performance.now() - started) / 1000);
  console.log(`  inference.stream events: ${streamEvents}`);
  if (streamEvents === 0) throw new Error("No inference.stream events were observed.");
  if (result.items.length !== 2) {
    throw new Error(`Expected exactly 2 items, got ${result.items.length}.`);
  }
}

async function stepB(model: string): Promise<void> {
  const started = performance.now();
  const result = await runStage(
    { ...baseSpec("smoke-b", model), streaming: false },
    'Napravi jednu kviz stavku o replikaciji sa tačno 1 elementom u "items" i hint: null.',
  );
  printJson("result", result, (performance.now() - started) / 1000);
}

async function stepC(model: string): Promise<void> {
  const session = openStageSession(baseSpec("smoke-c", model));
  try {
    const started = performance.now();
    const first = await session.send(
      'Napravi jednu kviz stavku o CAP teoremi sa 2 elementa u "items" i hint: null.',
    );
    printJson("first answer", first, (performance.now() - started) / 1000);

    const secondStarted = performance.now();
    const second = await session.send("Promeni questionType u 'open' i dodaj jedan item više");
    printJson("second answer", second, (performance.now() - secondStarted) / 1000);

    if (second.questionType !== "open") {
      throw new Error(`Expected questionType "open", got "${second.questionType}".`);
    }
    if (second.items.length !== first.items.length + 1) {
      throw new Error(
        `Expected ${first.items.length + 1} items in the second answer, got ${second.items.length}.`,
      );
    }
    console.log("  context kept across turns: yes");
  } finally {
    session.close();
  }
}

const RUNNERS: Record<Step, (model: string) => Promise<void>> = { a: stepA, b: stepB, c: stepC };

function describeError(error: unknown): void {
  if (error instanceof StageError) {
    console.error(`  FAILED [${error.kind}]: ${error.message}`);
    if (error.rawText !== undefined) {
      const raw = error.rawText;
      console.error(`  rawText: ${raw.length > 500 ? `${raw.slice(0, 500)}...` : raw}`);
    }
  } else {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const results: Result[] = [];

for (const model of models) {
  for (const step of steps) {
    console.log(`\n== ${model} :: ${STEP_LABELS[step]} ==`);
    const started = performance.now();
    let ok = false;
    try {
      await RUNNERS[step](model);
      ok = true;
    } catch (error) {
      describeError(error);
    }
    results.push({ model, step, ok, seconds: (performance.now() - started) / 1000 });
  }
}

console.log("\n== Summary ==");
const modelWidth = Math.max(5, ...results.map((r) => r.model.length));
const stepWidth = Math.max(...Object.values(STEP_LABELS).map((l) => l.length));
console.log(`${"model".padEnd(modelWidth)}  ${"step".padEnd(stepWidth)}  result  seconds`);
for (const r of results) {
  console.log(
    `${r.model.padEnd(modelWidth)}  ${STEP_LABELS[r.step].padEnd(stepWidth)}  ` +
      `${(r.ok ? "PASS" : "FAIL").padEnd(6)}  ${r.seconds.toFixed(1)}`,
  );
}

const allPassed = results.every((r) => r.ok);
console.log(allPassed ? "\nAll steps passed." : "\nSome steps FAILED.");
process.exit(allPassed ? 0 : 1);
