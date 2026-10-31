import { MAX_VIZ_SUGGESTIONS, VizSuggestions } from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import type { QuizContext, QuizTopicInput } from "../quiz/context.js";
import { runStage, type StageSpec } from "./stage.js";

export interface VizIdentifierOptions {
  onEvent?: StageSpec<VizSuggestions>["onEvent"];
}

/** A visualization topic the class already has (suggested earlier or added by the student). */
export interface ExistingVizTopic {
  concept: string;
  origin: "agent" | "user";
  selected: boolean;
}

export interface VizIdentifierInput {
  /** The class's lesson, topics and tracking history (the quiz planner's context). */
  ctx: QuizContext;
  /** Suggestions and visualizations the class already has, to avoid duplicates. */
  existing: ExistingVizTopic[];
}

const INSTRUCTION = `You are the tutor of a Serbian university course. A lesson note for one class is ready, and your job is to recommend which concepts of it deserve an interactive visualization. You only recommend. You never build anything: the student reads your short suggestions, picks the ones they want, and only then does a separate team plan and build them.

# Inputs

You receive, in the user message:
- the course name, the class number and title;
- the unified lesson note (inside <lekcija>), which is the source of truth. Its item tags: no tag = from the slides; (P) = the lecturer's spoken remark; (D) = an addition by the lesson's author. "> ⚠️ Ispravka:" callouts mark corrections of the student's notes;
- the topics of the class in lesson order, each with its rating (? = untested, ✗ = not understood, ~ = partly, ✓ = understood) and its history: misconceptions the student's notes contained (source "notes") and how quizzes and grading went (sources "quiz" and "grading");
- the concepts that already have a suggestion or a visualization for this class, when there are any.

# What to recommend

Recommend only concepts that are genuinely easier to grasp by interacting than by reading: dynamic processes, state changes over time, trade-offs under failure, layered or nested structures. Typical examples: sharding and repartitioning when a node is added, CAP under a network partition, Lambda versus Kappa architecture, the layers of a container image. A static definition, a list of terms or a plain comparison table is never a good visualization topic.

Prefer concepts tied to a misconception: one the student's notes contained, or one that shows up in the tracking history (a wrong quiz or grading outcome, a topic rated ✗ or ~). The best visualization is one where the wrong mental model visibly predicts one thing and the visualization shows another.

Be selective. Two to four suggestions is typical, five at most. If only one concept truly deserves a visualization, recommend one. Never pad the list to look thorough. If nothing in the lesson genuinely benefits from an interactive visualization, return an empty list ({"suggestions": []}); that is a valid, correct answer. Never recommend a concept that is already in the list of existing ones, or the same idea under another name.

# One suggestion

- concept: a short name of the concept (a few words), unique within your answer;
- section: the lesson section the concept comes from, as the heading path separated by " › ", for example "Inkrementalne arhitekture › Primer". Copy the headings from the lesson;
- misconception: the misconception the visualization breaks, in the form "the wrong model predicts X; the visualization shows Y". Write it concretely, in terms of what the student will see;
- summary: two to four sentences the student reads before deciding. It names the concept, the misconception it targets, what the student can control and which scenarios they can run. It must not give away the answers to quiz questions: describe what the student can explore, not the conclusions they should reach, and do not quote the corrections from the lesson's "Ispravka" callouts as findings;
- controls: 2-5 concrete controls the student would operate (for example "klizač: broj čvorova", "dugme: ugasi čvor 2", "prekidač: mod N / consistent hashing"). Each control must change visible state;
- scenarios: 2-4 scenarios, each with a name, the starting setup, the actions and the state the visualization must end in (for example "Dodavanje četvrtog čvora: počinje se sa 3 čvora i 12 ključeva; dodaj čvor; mod N premešta većinu ključeva, consistent hashing samo oko četvrtine"). The scenario that exposes the misconception is one of them.

Stay inside the lesson: facts shown by the visualization must come from the lesson. Do not describe how to implement anything (no frameworks, no code, no layout). That is the later team's job, and the student decides first.

# Language

Write every text field in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Never use Cyrillic. Established English technical terms (batch, streaming, sharding, ...) stay in English. Everything else in this instruction is in English only because it is addressed to you.

# Self-check before answering

Every concept is unique and not already existing. Each suggestion has a lesson section, a misconception in the "wrong model predicts X; the visualization shows Y" form, 2-5 controls and 2-4 scenarios with end states. No summary gives away a quiz answer. The list has at most ${MAX_VIZ_SUGGESTIONS} entries and no padding; it is empty when nothing deserves a visualization.

# Output

Return only the JSON object matching the required schema.`;

export function buildVizIdentifierInstruction(persona: string | null): string {
  if (persona === null) return INSTRUCTION;
  return `${INSTRUCTION}\n\nYou are also ${persona}; let that practical experience shape which concepts you find hard to grasp from reading alone.`;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

function formatTopic(topic: QuizTopicInput, index: number): string {
  const head = [
    `${index + 1}. ${topic.name}`,
    `[ocena: ${topic.rating}]`,
    topic.deferred ? "[ODLOŽENO]" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const lines = topic.history.map((h) => {
    const parts = [`${h.source}${h.ref ? ` ${h.ref}` : ""}`];
    if (h.outcome) parts.push(`ishod: ${h.outcome}`);
    if (h.misconception) parts.push(`zabluda: ${quote(h.misconception)}`);
    if (h.correction) parts.push(`ispravno: ${quote(h.correction)}`);
    return `   - ${parts.join("; ")}`;
  });
  return [head, ...lines].join("\n");
}

export function buildVizIdentifierMessage({ ctx, existing }: VizIdentifierInput): string {
  const sections = [
    [`Kurs: ${ctx.course.name}`, `Predavanje ${ctx.class.number}: ${ctx.class.title}`].join("\n"),
    `<lekcija>\n${ctx.lessonMd}\n</lekcija>`,
    `Teme ovog predavanja (redom u lekciji), sa istorijom:\n${ctx.topics.map(formatTopic).join("\n")}`,
    existing.length > 0
      ? "Koncepti koji već imaju predlog ili vizualizaciju za ovo predavanje (ne predlaži ih ponovo):\n" +
        existing
          .map(
            (e) =>
              `- ${e.concept} (${e.origin === "user" ? "dodao student" : "raniji predlog"}${e.selected ? ", izabrano" : ""})`,
          )
          .join("\n")
      : "Za ovo predavanje još nema predloga ni vizualizacija.",
    "Predloži teme za vizualizacije prema uputstvu.",
  ];
  return sections.join("\n\n");
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The suggestions schema plus the cross-field checks the model can fix when told about them (the
 * stage's repair loop sends these messages back).
 */
export function vizSuggestionsSchema(
  existing: readonly ExistingVizTopic[] = [],
): z.ZodType<VizSuggestions> {
  const taken = new Set(existing.map((e) => normalize(e.concept)));
  return VizSuggestions.superRefine((value, zctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      zctx.addIssue({ code: "custom", message, path });
    };
    if (value.suggestions.length > MAX_VIZ_SUGGESTIONS) {
      issue(
        `Return at most ${MAX_VIZ_SUGGESTIONS} suggestions, not ${value.suggestions.length}; keep the ones that benefit most from interaction.`,
        ["suggestions"],
      );
    }
    const seen = new Set<string>();
    value.suggestions.forEach((s, i) => {
      const at = (field: string): (string | number)[] => ["suggestions", i, field];
      const key = normalize(s.concept);
      if (seen.has(key)) {
        issue(
          `Suggestion #${i + 1}: the concept "${s.concept}" appears twice; every concept must be unique.`,
          at("concept"),
        );
      }
      seen.add(key);
      if (taken.has(key)) {
        issue(
          `Suggestion #${i + 1}: "${s.concept}" already has a suggestion or visualization; recommend a different concept.`,
          at("concept"),
        );
      }
      if (s.controls.length < 2 || s.controls.length > 5) {
        issue(
          `Suggestion #${i + 1} ("${s.concept}") has ${s.controls.length} controls; it needs 2 to 5.`,
          at("controls"),
        );
      }
      if (s.scenarios.length < 2 || s.scenarios.length > 4) {
        issue(
          `Suggestion #${i + 1} ("${s.concept}") has ${s.scenarios.length} scenarios; it needs 2 to 4, each with the state it ends in.`,
          at("scenarios"),
        );
      }
    });
  });
}

export function vizIdentifierSpec(
  input: VizIdentifierInput,
  opts: VizIdentifierOptions = {},
): StageSpec<VizSuggestions> {
  return {
    name: "viz-identifier",
    instruction: buildVizIdentifierInstruction(input.ctx.course.persona),
    model: config.MODEL_PLANNER,
    schema: vizSuggestionsSchema(input.existing),
    schemaName: "viz_suggestions",
    maxOutputTokens: 8000,
    timeoutMs: 10 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function identifyVizTopics(
  input: VizIdentifierInput,
  opts: VizIdentifierOptions = {},
): Promise<VizSuggestions> {
  return runStage(vizIdentifierSpec(input, opts), buildVizIdentifierMessage(input));
}
