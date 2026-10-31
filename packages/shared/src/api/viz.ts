import { z } from "zod";

export const VIZ_SUGGESTION_ORIGINS = ["agent", "user"] as const;
export const VizSuggestionOrigin = z.enum(VIZ_SUGGESTION_ORIGINS);
export type VizSuggestionOrigin = z.infer<typeof VizSuggestionOrigin>;

export const VizSuggestion = z.object({
  id: z.number().int(),
  classId: z.number().int(),
  concept: z.string(),
  /** Lesson section path; empty for a user topic until the planner fills it in. */
  section: z.string(),
  misconception: z.string(),
  summary: z.string(),
  controls: z.array(z.string()),
  scenarios: z.array(z.string()),
  origin: VizSuggestionOrigin,
  selected: z.boolean(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type VizSuggestion = z.infer<typeof VizSuggestion>;

/** A topic the student adds on their own. */
export const CreateVizSuggestionInput = z.strictObject({
  concept: z.string().trim().min(1).max(200),
  /** Free text about what to show; an empty string means "none". */
  note: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});
export type CreateVizSuggestionInput = z.input<typeof CreateVizSuggestionInput>;

export const SelectVizSuggestionsInput = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type SelectVizSuggestionsInput = z.infer<typeof SelectVizSuggestionsInput>;

/** A released visualization; the page itself is served separately (never inlined in lists). */
export const VisualizationSummary = z.object({
  id: z.number().int(),
  classId: z.number().int(),
  /** Null when the suggestion was deleted. */
  suggestionId: z.number().int().nullable(),
  slug: z.string(),
  title: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
});
export type VisualizationSummary = z.infer<typeof VisualizationSummary>;
