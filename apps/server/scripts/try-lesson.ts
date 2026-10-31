/**
 * Manual check of the lesson writer on a real class from the app DB. Calls the paid Anthropic API.
 *
 *   npm run lesson:try -- --class <id>
 *
 * Writes <DATA_DIR>/tmp/lesson-<id>.md and <DATA_DIR>/tmp/lesson-<id>.topics.json.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { asc, eq } from "drizzle-orm";
import { initAgentRuntime } from "../src/agents/runtime.js";
import { StageError } from "../src/agents/stage.js";
import { writeLesson, type LessonSource } from "../src/agents/lesson-writer.js";
import { config } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { classTable, course, material } from "../src/db/schema.js";

const { values } = parseArgs({ options: { class: { type: "string" } }, allowPositionals: false });

const classId = Number(values.class);
if (!values.class || !Number.isInteger(classId) || classId <= 0) {
  console.error("Usage: npm run lesson:try -- --class <id>");
  process.exit(2);
}
if (!config.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to the repo-root .env and run again.");
  process.exit(1);
}

const { db, close } = openDatabase(config.DATA_DIR);

const row = db
  .select({ cls: classTable, course })
  .from(classTable)
  .innerJoin(course, eq(course.id, classTable.courseId))
  .where(eq(classTable.id, classId))
  .get();
if (!row) {
  console.error(`Class ${classId} does not exist in ${path.join(config.DATA_DIR, "app.sqlite")}.`);
  close();
  process.exit(1);
}

const files = db
  .select()
  .from(material)
  .where(eq(material.classId, classId))
  .orderBy(asc(material.originalName), asc(material.id))
  .all();

function sourcesOf(kind: "material" | "note"): LessonSource[] {
  return files
    .filter((f) => f.kind === kind && (kind === "note" || f.extractionStatus === "ok"))
    .filter((f) => f.extractedText !== null)
    .map((f) => ({ name: f.originalName, text: f.extractedText ?? "" }));
}

const materials = sourcesOf("material");
const notes = sourcesOf("note");
close();

if (materials.length === 0) {
  console.error(`Class ${classId} has no successfully extracted materials.`);
  process.exit(1);
}

console.log(
  `Course "${row.course.name}", class ${row.cls.number} "${row.cls.title}": ` +
    `${materials.length} material(s), ${notes.length} note(s). Model: ${config.MODEL_PLANNER}.`,
);

const logger = {
  warn(obj: object, msg: string): void {
    console.warn(`\n[runner warn] ${msg}`, obj);
  },
};
initAgentRuntime({ logger });

let streamEvents = 0;
const started = performance.now();
try {
  const draft = await writeLesson(
    {
      course: {
        name: row.course.name,
        persona: row.course.persona,
        assessmentFormat: row.course.assessmentFormat,
      },
      class: { number: row.cls.number, title: row.cls.title },
      materials,
      notes,
    },
    {
      onEvent: (event) => {
        if (event.type === "inference.stream" && ++streamEvents % 50 === 0) {
          process.stdout.write(".");
        }
      },
    },
  );
  const seconds = (performance.now() - started) / 1000;

  const outDir = path.join(config.DATA_DIR, "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const lessonPath = path.join(outDir, `lesson-${classId}.md`);
  const topicsPath = path.join(outDir, `lesson-${classId}.topics.json`);
  fs.writeFileSync(lessonPath, draft.lessonMd);
  fs.writeFileSync(topicsPath, `${JSON.stringify(draft.topics, null, 2)}\n`);

  console.log(`\nDone in ${seconds.toFixed(1)}s (${streamEvents} stream events).`);
  console.log(`Lesson: ${lessonPath} (${draft.lessonMd.length} characters)`);
  console.log(`Topics: ${topicsPath}`);
  console.log(`\n${draft.topics.length} topics:`);
  draft.topics.forEach((t, i) => {
    const flags = [
      t.deferred ? "deferred" : "",
      t.misconceptions.length > 0 ? `${t.misconceptions.length} misconception(s)` : "",
    ].filter(Boolean);
    console.log(`  ${i + 1}. ${t.name}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`);
  });
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
