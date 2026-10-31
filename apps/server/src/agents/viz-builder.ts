import {
  VizDraft,
  formatVizReport,
  validateVizHtml,
  vizHtmlTitle,
  type VizPlan,
  type VizReport,
  type VizReviewFix,
} from "@studdy/shared";
import { z } from "zod";
import { config } from "../config.js";
import { openStageSession, runStage, type StageSession, type StageSpec } from "./stage.js";

export interface VizBuilderOptions {
  onEvent?: StageSpec<VizDraft>["onEvent"];
}

export interface VizBuilderInput {
  plan: VizPlan;
  lessonMd: string;
}

const INSTRUCTION = `You are the visualization builder for a Serbian university course. A tutor (the planner) has written a plan for one interactive visualization: the concept, the misconception it breaks, the layout, the controls, the scenarios with the exact state each must end in, the terminology. Your job is to turn that plan into ONE self-contained HTML page that the student opens in a browser. A reviewer will walk every scenario through your code and may send you a list of fixes.

# Inputs

You receive, in the user message:
- the plan as JSON;
- the lesson note (inside <lekcija>), the source of truth for every fact on the page.

# The page (design contract)

- One HTML file: starts with <!doctype html>, has <meta charset="utf-8"> and <meta name="viewport" content="width=device-width, initial-scale=1">, and a <title> that is exactly the plan's title (2-4 words).
- Inline CSS and JavaScript only. No external dependencies of any kind: no <script src>, no <link>, no @import, no web fonts, no CDN, no external images (draw with HTML, CSS and inline SVG), no fetch / XMLHttpRequest / WebSocket. No external links or navigation of any kind: the only allowed <a href> / <area href> value is an in-page fragment (href="#id") or none; no http, mailto:, javascript:, relative-path links, no <form action>, no <base href> (a click would navigate the frame away from the page), no window.open, no location changes, no <meta http-equiv="refresh">. Cite sources as plain text.
- Light and dark themes: define colors as CSS custom properties on :root, and override them in @media (prefers-color-scheme: dark). Both themes must be readable, with sufficient contrast for text and for every colored mark.
- Works at 390 px width without horizontal scrolling of the page: a fluid layout, wrapping controls, SVG with a viewBox that scales, tables that wrap or scroll inside their own box. It also uses a desktop width well.
- Respects prefers-reduced-motion: with reduce, no animations or transitions (state changes still show, just instantly).
- Keyboard accessible: real <button>, <input>, <select> elements with visible labels, a visible focus style, a sensible tab order; state is never conveyed by color alone (add text, a shape or a label).
- Storage is optional: the page works fully without it. If you remember anything (the last selected scenario, for example), wrap every localStorage / sessionStorage access in try/catch and never depend on the result.
- UI text is in Serbian, Latin script, with correct diacritics (č, ć, š, ž, đ). Established English technical terms (batch, streaming, sharding, ...) stay in English. No Cyrillic. Code identifiers stay in English.

# Behavior (what the plan fixes)

- Build every control of the plan with the name the plan gives it, and make each one change visible state, exactly as the plan's effect says. No decorative controls.
- A caption or event log (an element with aria-live="polite") says in a sentence what just happened and WHY, after every action: not "Dodat čvor", but what that did to the data and the reason according to the lesson.
- Build in every scenario of the plan, for example as a "Scenario" selector or one button per scenario that runs the steps to its end state, so the student can run it with one click and then keep experimenting. After the scenario runs, the page is in exactly the plan's expectedEndState (the reviewer checks this by reading your code). The scenario that reproduces the misconception shows the wrong model's prediction failing, and the caption says why.
- Include a reset control that returns the page to its starting state.
- A reasonable starting state: the page is understandable before the student touches anything (a short intro line stating what to try).
- Facts come from the lesson only. Use the plan's terminology consistently. The plan lists tutor additions in "dopuna": every statement on the page that is not in the lesson (also a number or real-world claim you add) is visibly labeled "dopuna" (for example a small badge or the prefix "dopuna:"), so the student can tell it from the lesson. Illustrative numbers (12 keys, 3 nodes) are fine when the page says that they are illustrative.
- If something in the plan looks wrong or impossible (a scenario cannot end in the stated state, a fact contradicts the lesson), do not silently change it: build the closest correct thing and describe the problem in "notes" for the reviewer. Without problems, "notes" is an empty list.
- The page is small and clear. No frameworks, no build step. Code that is simple enough that a reader can follow what each click does.

# Output

Return only the JSON object {html, notes} matching the required schema; "html" is the complete page. When you later receive a list of fixes from the reviewer (and possibly an automatic contract report), apply every fix, change nothing else that was not asked for, and return the COMPLETE corrected page again in "html", never a diff or a fragment.`;

export function buildVizBuilderInstruction(): string {
  return INSTRUCTION;
}

export function buildVizBuilderMessage(input: VizBuilderInput): string {
  return [
    `Plan vizualizacije (JSON):\n${JSON.stringify(input.plan, null, 2)}`,
    `<lekcija>\n${input.lessonMd}\n</lekcija>`,
    `Napravi stranicu "${input.plan.title}" prema planu i uputstvu, i vrati {html, notes}.`,
  ].join("\n\n");
}

/** The message for a fix cycle on the builder's session. */
export function buildVizFixMessage(fixes: VizReviewFix[], report?: VizReport): string {
  const parts = [
    "Recenzent traži ispravke. Primeni svaku od njih; ne menjaj ništa što nije traženo " +
      "(i nikad ono što plan fiksira):",
    ...fixes.map((f, i) => `${i + 1}. ${f.area}: ${f.problem}\n   Izmena: ${f.change}`),
  ];
  if (report && (report.errors.length > 0 || report.warnings.length > 0)) {
    parts.push(`Izveštaj automatske provere stranice:\n${formatVizReport(report)}`);
  }
  parts.push("Vrati KOMPLETNU ispravljenu stranicu u polju html, ne samo izmenjene delove.");
  return parts.join("\n\n");
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The draft schema plus the static design-contract errors: each one goes back to the builder
 * through the stage's repair loop. Warnings are left to the reviewer.
 */
export function vizDraftSchema(plan: VizPlan): z.ZodType<VizDraft> {
  return VizDraft.superRefine((draft, zctx) => {
    const issue = (message: string): void => {
      zctx.addIssue({ code: "custom", message, path: ["html"] });
    };
    for (const e of validateVizHtml(draft.html).errors) {
      issue(`Design contract [${e.code}]: ${e.message}`);
    }
    const title = vizHtmlTitle(draft.html);
    if (title !== null && normalize(title) !== normalize(plan.title)) {
      issue(`The <title> must be exactly "${plan.title}" as in the plan, not "${title}".`);
    }
    if (plan.dopuna.length > 0 && !/dopuna/i.test(draft.html)) {
      issue(
        'The plan lists tutor additions ("dopuna"), but the page never labels anything "dopuna". ' +
          'Label each of them visibly with the word "dopuna".',
      );
    }
  });
}

export function vizBuilderSpec(plan: VizPlan, opts: VizBuilderOptions = {}): StageSpec<VizDraft> {
  return {
    name: "viz-builder",
    instruction: buildVizBuilderInstruction(),
    model: config.MODEL_BUILDER,
    schema: vizDraftSchema(plan),
    schemaName: "viz_draft",
    maxOutputTokens: 64_000,
    timeoutMs: 30 * 60 * 1000,
    repairAttempts: 2,
    ...(opts.onEvent && { onEvent: opts.onEvent }),
  };
}

/** A multi-turn builder: send the build message, then fix rounds on the same conversation. */
export function openVizBuilderSession(
  plan: VizPlan,
  opts: VizBuilderOptions = {},
): StageSession<VizDraft> {
  return openStageSession(vizBuilderSpec(plan, opts));
}

/** One-shot build, without fix cycles. */
export async function buildViz(
  input: VizBuilderInput,
  opts: VizBuilderOptions = {},
): Promise<VizDraft> {
  return runStage(vizBuilderSpec(input.plan, opts), buildVizBuilderMessage(input));
}
