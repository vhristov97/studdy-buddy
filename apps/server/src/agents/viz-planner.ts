import { MAX_VIZ_SLUG_LENGTH, VIZ_SLUG_PATTERN, VizPlan, countTitleWords } from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import type { QuizContext, QuizTopicInput } from "../quiz/context.js";
import { runStage, type StageSpec } from "./stage.js";

export interface VizPlannerOptions {
  onEvent?: StageSpec<VizPlan>["onEvent"];
}

/** The topic to plan: an agent suggestion the student approved, or one the student added. */
export interface VizPlannerSuggestion {
  concept: string;
  section: string;
  misconception: string;
  summary: string;
  controls: string[];
  scenarios: string[];
  origin: "agent" | "user";
}

export interface VizPlannerInput {
  /** The class's lesson, topics and tracking history (the quiz planner's context). */
  ctx: QuizContext;
  suggestion: VizPlannerSuggestion;
}

const INSTRUCTION = `You are the tutor of a Serbian university course, planning one interactive visualization: a single self-contained HTML page that helps the student grasp one concept of a lesson by playing with it. You are the strong-model planner: you decide what the page teaches and exactly what every control and scenario must do. A cheaper builder model turns your plan into the page, and you review its result afterwards. The student has already approved the topic, so plan the visualization, do not question it.

# Inputs

You receive, in the user message:
- the course name, the class number and title;
- the unified lesson note (inside <lekcija>), the source of truth. Its item tags: no tag = from the slides; (P) = the lecturer's spoken remark; (D) = an addition by the lesson's author (the tutor). "> ⚠️ Ispravka:" callouts mark corrections of the student's notes;
- the topics of the class in lesson order with their ratings (? = untested, ✗ = not understood, ~ = partly, ✓ = understood) and history: misconceptions in the student's notes (source "notes") and how quizzes and grading went (sources "quiz" and "grading");
- the approved topic. For a topic suggested by the tutor: the concept, the lesson section, the misconception, the summary the student read, and the suggested controls and scenarios; keep the concept and the spirit of the summary, and refine everything else freely. For a topic the student added: only the concept and perhaps a note; you pick the lesson section, the misconception, the controls and the scenarios yourself.

# The plan

- title: 2-4 words in Serbian, the name shown on the page and in the library (for example "Sharding pod lupom").
- slug: the title as lowercase ASCII words joined by single hyphens (č, ć -> c, š -> s, ž -> z, đ -> dj), for example "sharding-pod-lupom".
- concept and section: the concept, and the lesson section it comes from as the heading path separated by " › ", copied from the lesson's headings.
- misconception: the misconception the page breaks, as two statements: wrongModelPredicts (what the wrong mental model says will happen, in terms of what the student will see) and vizShows (what the page shows instead). Prefer a misconception from the student's notes or tracking history; otherwise the typical wrong model for the concept. The page must make the difference visible, not only describe it.
- layout: how the page is laid out: the regions, what sits where, what the picture looks like (a ring of nodes, layers stacked, a timeline), where the caption or event log goes. It must work on a phone (about 390 px wide) as well as on a desktop, in light and dark themes.
- controls: 2-6 controls the student operates (sliders, buttons, toggles, selectors). For each: its name as written on the page and the effect, meaning the visible state change it causes. EVERY control must change something visible; no decorative controls, no controls that only change a number nobody sees.
- scenarios: 2-5 scenarios, each with a name, the steps the student performs (buttons or a selector can run a scenario for them) and the expectedEndState: the exact state the page must end in, concretely enough that someone can check it (counts, positions, colors, caption text). One scenario explicitly reproduces the misconception, so that the student sees the wrong model's prediction fail and why.
- terminology: the terms the page uses, each with the meaning the lesson gives it. The page uses these terms consistently.
- dopuna: tutor additions: any fact, number or explanation the page shows that is NOT in the lesson. Prefer to have none. Every entry here must be labeled "dopuna" on the page, so the student can tell it from the lesson.

# Facts

Facts shown by the page come from the lesson only. Where you need a number or a detail that the lesson does not give, you may invent illustrative values (for example 12 keys, 3 nodes), but say so in the layout or scenario text, and put every real-world claim that is not in the lesson in dopuna. Where the lesson has a "⚠️ Ispravka" correction, the page uses the corrected statement, never the wrong wording. Do not describe code, frameworks or libraries; the page is plain HTML, CSS and JavaScript with no external dependencies, and that is the builder's job.

# Language

Write every text field in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never use Cyrillic. Established English technical terms (batch, streaming, sharding, ...) stay in English. The slug is ASCII. Everything else in this instruction is in English only because it is addressed to you.

# Self-check before answering

Title of 2-4 words; slug in the right form; 2-6 controls with distinct names, each changing visible state; 2-5 scenarios, each with steps and an exact end state, one of them reproducing the misconception; every fact traceable to the lesson or listed in dopuna; no Cyrillic.

# Output

Return only the JSON object matching the required schema.`;

export function buildVizPlannerInstruction(persona: string | null): string {
  if (persona === null) return INSTRUCTION;
  return `${INSTRUCTION}\n\nYou are also ${persona}; let that practical experience shape the examples and the scenarios you choose.`;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

function formatTopic(topic: QuizTopicInput, index: number): string {
  const head =
    `${index + 1}. ${topic.name} [ocena: ${topic.rating}]` + (topic.deferred ? " [ODLOŽENO]" : "");
  const lines = topic.history.map((h) => {
    const parts = [`${h.source}${h.ref ? ` ${h.ref}` : ""}`];
    if (h.outcome) parts.push(`ishod: ${h.outcome}`);
    if (h.misconception) parts.push(`zabluda: ${quote(h.misconception)}`);
    if (h.correction) parts.push(`ispravno: ${quote(h.correction)}`);
    return `   - ${parts.join("; ")}`;
  });
  return [head, ...lines].join("\n");
}

function formatSuggestion(s: VizPlannerSuggestion): string {
  if (s.origin === "user") {
    const note = s.misconception.trim();
    return [
      "Tema koju je student sam dodao (sve ostalo određuješ ti):",
      `Koncept: ${s.concept}`,
      note !== "" ? `Napomena studenta: ${note}` : "Napomena studenta: nema.",
    ].join("\n");
  }
  return [
    "Odobrena tema (student je pročitao ovaj sažetak):",
    `Koncept: ${s.concept}`,
    `Odeljak lekcije: ${s.section}`,
    `Zabluda koju razbija: ${s.misconception}`,
    `Sažetak: ${s.summary}`,
    `Predložene kontrole:\n${s.controls.map((c) => `- ${c}`).join("\n")}`,
    `Predloženi scenariji:\n${s.scenarios.map((c) => `- ${c}`).join("\n")}`,
  ].join("\n");
}

export function buildVizPlannerMessage({ ctx, suggestion }: VizPlannerInput): string {
  return [
    `Kurs: ${ctx.course.name}\nPredavanje ${ctx.class.number}: ${ctx.class.title}`,
    `<lekcija>\n${ctx.lessonMd}\n</lekcija>`,
    `Teme ovog predavanja (redom u lekciji), sa istorijom:\n${ctx.topics.map(formatTopic).join("\n")}`,
    formatSuggestion(suggestion),
    "Napravi plan vizualizacije prema uputstvu.",
  ].join("\n\n");
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

function findDuplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const name of names) {
    const key = normalize(name);
    if (seen.has(key)) dup.add(name);
    seen.add(key);
  }
  return [...dup];
}

/**
 * The plan schema plus the cross-field checks the model can fix when told about them (the
 * stage's repair loop sends these messages back).
 */
export function vizPlanSchema(): z.ZodType<VizPlan> {
  return VizPlan.superRefine((plan, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };

    const words = countTitleWords(plan.title);
    if (words < 2 || words > 4) {
      issue(`The title "${plan.title}" has ${words} words; it needs 2 to 4.`, ["title"]);
    }
    if (!VIZ_SLUG_PATTERN.test(plan.slug) || plan.slug.length > MAX_VIZ_SLUG_LENGTH) {
      issue(
        `The slug "${plan.slug}" must be lowercase ASCII words joined by single hyphens ` +
          `(at most ${MAX_VIZ_SLUG_LENGTH} characters), e.g. "sharding-pod-lupom".`,
        ["slug"],
      );
    }
    if (plan.controls.length < 2 || plan.controls.length > 6) {
      issue(`The plan has ${plan.controls.length} controls; it needs 2 to 6.`, ["controls"]);
    }
    for (const name of findDuplicates(plan.controls.map((c) => c.name))) {
      issue(`The control name "${name}" is used twice; control names must be unique.`, [
        "controls",
      ]);
    }
    if (plan.scenarios.length < 2 || plan.scenarios.length > 5) {
      issue(`The plan has ${plan.scenarios.length} scenarios; it needs 2 to 5.`, ["scenarios"]);
    }
    for (const name of findDuplicates(plan.scenarios.map((s) => s.name))) {
      issue(`The scenario name "${name}" is used twice; scenario names must be unique.`, [
        "scenarios",
      ]);
    }
    plan.scenarios.forEach((s, i) => {
      if (s.steps.length < 1) {
        issue(`Scenario "${s.name}" needs at least one step.`, ["scenarios", i, "steps"]);
      }
    });
  });
}

export function vizPlannerSpec(
  input: VizPlannerInput,
  opts: VizPlannerOptions = {},
): StageSpec<VizPlan> {
  return {
    name: "viz-planner",
    instruction: buildVizPlannerInstruction(input.ctx.course.persona),
    model: config.MODEL_PLANNER,
    schema: vizPlanSchema(),
    schemaName: "viz_plan",
    maxOutputTokens: 16_000,
    timeoutMs: 15 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function planViz(
  input: VizPlannerInput,
  opts: VizPlannerOptions = {},
): Promise<VizPlan> {
  return runStage(vizPlannerSpec(input, opts), buildVizPlannerMessage(input));
}
