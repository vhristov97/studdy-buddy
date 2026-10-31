import { z } from "zod";

/** Output of the viz-identifier agent: one recommended visualization topic. */
export const VizSuggestionDraft = z.object({
  /** Short Serbian name of the concept, e.g. "Sharding pod lupom". */
  concept: z.string().trim().min(1).max(200),
  /** The lesson section the concept comes from, as a heading path ("A › B"). */
  section: z.string().trim().min(1).max(300),
  /** "The wrong model predicts X; the visualization shows Y." */
  misconception: z.string().trim().min(1).max(1000),
  /** Spoiler-free: concept, the misconception it targets, controls, scenarios; no quiz answers. */
  summary: z.string().trim().min(1).max(1500),
  /** The controls the student would use (2-5). */
  controls: z.array(z.string().trim().min(1).max(300)).min(1),
  /** Scenarios, each with the state it must end in (2-4). */
  scenarios: z.array(z.string().trim().min(1).max(600)).min(1),
});
export type VizSuggestionDraft = z.infer<typeof VizSuggestionDraft>;

export const MAX_VIZ_SUGGESTIONS = 5;

/** 0..MAX_VIZ_SUGGESTIONS (max enforced by the identifier's refinement): an empty list means nothing benefits. */
export const VizSuggestions = z.object({
  suggestions: z.array(VizSuggestionDraft),
});
export type VizSuggestions = z.infer<typeof VizSuggestions>;
