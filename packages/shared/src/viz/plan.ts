import { z } from "zod";

/** Slugs are lowercase ASCII words joined by single hyphens, e.g. `sharding-pod-lupom`. */
export const VIZ_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_VIZ_SLUG_LENGTH = 60;

/** The viz-planner's answer (spec §12 "Plan"). Never sent to the web app. */
export const VizPlan = z.object({
  /** 2-4 words, Serbian; becomes the page `<title>`. */
  title: z.string().trim().min(1).max(100),
  /** Kebab-case ASCII; unique per class (the server appends `-2`, `-3` on a collision). */
  slug: z.string().trim().min(1).max(MAX_VIZ_SLUG_LENGTH),
  /** The concept the visualization teaches. */
  concept: z.string().trim().min(1).max(300),
  /** The lesson section the concept comes from, as a heading path ("A › B"). */
  section: z.string().trim().min(1).max(300),
  misconception: z.object({
    /** What the wrong mental model predicts the student will see. */
    wrongModelPredicts: z.string().trim().min(1),
    /** What the visualization actually shows. */
    vizShows: z.string().trim().min(1),
  }),
  /** The page layout: regions, what sits where, what the picture looks like. */
  layout: z.string().trim().min(1),
  controls: z.array(
    z.object({
      name: z.string().trim().min(1).max(200),
      /** The visible state change the control causes. */
      effect: z.string().trim().min(1),
    }),
  ),
  scenarios: z.array(
    z.object({
      name: z.string().trim().min(1).max(200),
      /** What the student does, in order. */
      steps: z.array(z.string().trim().min(1)),
      /** The exact visible state the scenario must end in. */
      expectedEndState: z.string().trim().min(1),
    }),
  ),
  /** Terms used in the page with the meaning the lesson gives them. */
  terminology: z.array(
    z.object({
      term: z.string().trim().min(1),
      meaning: z.string().trim().min(1),
    }),
  ),
  /** Tutor additions that are not in the lesson; the page must label each one "dopuna". */
  dopuna: z.array(z.string().trim().min(1)),
});
export type VizPlan = z.infer<typeof VizPlan>;
