import { VizReview, formatVizReport, type VizPlan, type VizReport } from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import { runStage, type StageSpec } from "./stage.js";

export interface VizReviewerOptions {
  onEvent?: StageSpec<VizReview>["onEvent"];
}

export interface VizReviewerInput {
  plan: VizPlan;
  html: string;
  /** The builder's remarks about problems in the plan. */
  notes: string[];
  lessonMd: string;
  /** The static design-contract report on `html`. */
  report: VizReport;
}

const INSTRUCTION = `You are the tutor of a Serbian university course, reviewing an interactive visualization (one self-contained HTML page) that a cheaper builder model has built from your own visualization plan. You decide whether the page can be released to the student, or which fixes the builder must make first. A scenario that ends in the wrong state, a control that does nothing visible, or a caption that teaches something false does real damage: the student learns from this page.

# Inputs

You receive, in the user message:
- the plan as JSON (your own earlier work: concept, the misconception, layout, controls, scenarios with expected end states, terminology, dopuna);
- the page's complete HTML, with its CSS and JavaScript;
- the builder's notes: problems it noticed in the plan;
- the automatic checker's report on the static design contract (errors, warnings);
- the lesson note (inside <lekcija>), the source of truth. Its tags: no tag = from the slides; (P) = the lecturer's remark; (D) = the tutor's addition.

# What to check

You cannot run the page, so read the code and simulate it. Be concrete.
1. Scenarios: for EACH scenario of the plan, walk it through the code: which element the student clicks (or which scenario button/selector they use), which handler runs, which state results after each step, and what the page shows at the end. The end state must equal the plan's expectedEndState (counts, positions, labels, caption). The misconception scenario must visibly show the wrong model's prediction failing, with the caption saying why.
2. Controls: every control of the plan exists with its planned name and changes visible state as the plan's effect says; no control that is wired to nothing, to a missing element id or to a function that does not exist; no JavaScript error on load or on a click (a typo, an undefined variable, a null element). A reset control returns to the start.
3. Caption / event log: an aria-live region says after every action what happened and why, and what it says is correct according to the lesson.
4. Facts: everything the page states agrees with the lesson (and uses the lesson's corrected statements, not the wrong wording of "⚠️ Ispravka" callouts). Every statement that is not in the lesson is visibly labeled "dopuna", and the plan's dopuna entries are all labeled. Illustrative numbers are marked as such.
5. Language: UI text is Serbian, Latin script, correct diacritics, natural wording, English technical terms kept. No Cyrillic. No leftover placeholder text.
6. Design contract: the checker's errors must be none; consider its warnings. Beyond the checker: both themes are defined with CSS custom properties and every colored mark and all text stays readable in both; the layout does not overflow at 390 px width (fluid widths, wrapping, scalable SVG; no fixed widths that exceed 390 px); prefers-reduced-motion is respected; controls are real, labeled, keyboard-focusable elements; state is not conveyed by color alone; storage access, if any, is in try/catch and optional; nothing external is loaded.
7. The title is the plan's title, and the page has the planned terminology.
8. The builder's notes: weigh each. If a note shows a real problem in the plan, you may correct your own plan: ask for the new behavior in "change" and say explicitly that this corrects the plan.

# Verdict

- approved = true only when nothing material is left. Cosmetic nits alone (a slightly clumsy phrase, a marginal spacing issue) do not block approval; mention them in the summary at most.
- approved = false when anything material is wrong: a scenario ending in the wrong state, a dead or misleading control, a false fact, a fact that is not in the lesson and lacks the "dopuna" label, a JavaScript error, a contract violation, an unreadable theme, overflow at phone width, wrong language.
- When approved, "fixes" is an empty list. When not approved, "fixes" has at least one entry.
- A fix names the area (for example "scenario: Ispad čvora", "control: Dodaj čvor", "caption", "facts", "design contract", "language"), what is wrong (problem, with the evidence from the code: the handler, the function, the line of reasoning) and the exact change you want (change: the behavior to implement, the wording to use). The builder applies it without further thinking, so be specific, and never ask for something the plan does not call for (except the explicit plan corrections described above). Keep the list to what really needs fixing; do not rewrite what is fine.
- summary: two to four sentences in English about the overall quality and what the fixes cover.

Write problem and change in English, quoting Serbian wording where you need it to be exact. Serbian text you ask for follows the same rules as the page: Latin script, correct diacritics.

# Output

Return only the JSON object matching the required schema.`;

export function buildVizReviewerInstruction(): string {
  return INSTRUCTION;
}

export function buildVizReviewerMessage(input: VizReviewerInput): string {
  return [
    `Plan vizualizacije (JSON):\n${JSON.stringify(input.plan, null, 2)}`,
    `Stranica (HTML):\n<stranica>\n${input.html}\n</stranica>`,
    input.notes.length > 0
      ? "Beleške graditelja (mesta gde plan izgleda pogrešno):\n" +
        input.notes.map((n) => `- ${n}`).join("\n")
      : "Graditelj nije ostavio beleške.",
    `Izveštaj automatske provere:\n${formatVizReport(input.report)}`,
    `<lekcija>\n${input.lessonMd}\n</lekcija>`,
    `Pregledaj vizualizaciju "${input.plan.title}" prema uputstvu.`,
  ].join("\n\n");
}

/** The review schema plus the checks the model can fix when told about them: approved iff no fixes. */
export function vizReviewSchema(): z.ZodType<VizReview> {
  return VizReview.superRefine((review, zctx) => {
    if (review.approved && review.fixes.length > 0) {
      zctx.addIssue({
        code: "custom",
        message: "approved is true but fixes is not empty; approve only with an empty fixes list.",
        path: ["fixes"],
      });
    }
    if (!review.approved && review.fixes.length === 0) {
      zctx.addIssue({
        code: "custom",
        message: "approved is false, so fixes must list at least one concrete fix.",
        path: ["fixes"],
      });
    }
  });
}

export function vizReviewerSpec(opts: VizReviewerOptions = {}): StageSpec<VizReview> {
  return {
    name: "viz-reviewer",
    instruction: buildVizReviewerInstruction(),
    model: config.MODEL_PLANNER,
    schema: vizReviewSchema(),
    schemaName: "viz_review",
    maxOutputTokens: 16_000,
    timeoutMs: 15 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

export async function reviewViz(
  input: VizReviewerInput,
  opts: VizReviewerOptions = {},
): Promise<VizReview> {
  return runStage(vizReviewerSpec(opts), buildVizReviewerMessage(input));
}
