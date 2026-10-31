import { and, asc, eq, inArray } from "drizzle-orm";
import type { VisualizationSummary, VizSuggestion } from "@studdy/shared";
import type { Db } from "../db/client.js";
import { classTable, visualization, vizSuggestion } from "../db/schema.js";
import { ApiError } from "../routes/errors.js";
import { ConflictError } from "./conflict.js";

type SuggestionRow = typeof vizSuggestion.$inferSelect;

export function toVizSuggestion(row: SuggestionRow): VizSuggestion {
  return {
    id: row.id,
    classId: row.classId,
    concept: row.concept,
    section: row.section,
    misconception: row.misconception,
    summary: row.summary,
    controls: row.controlsJson,
    scenarios: row.scenariosJson,
    origin: row.origin,
    selected: row.selected,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The agent's suggestions first (by id), then the student's own. */
export function listVizSuggestions(db: Db, classId: number): VizSuggestion[] {
  return db
    .select()
    .from(vizSuggestion)
    .where(eq(vizSuggestion.classId, classId))
    .orderBy(asc(vizSuggestion.origin), asc(vizSuggestion.id))
    .all()
    .map(toVizSuggestion);
}

/**
 * Adds a topic of the student's own. The planner (M7.2) fills in the details, so only the
 * concept and the note are stored. Throws a 409 unless the class is `ready`.
 */
export function addUserVizSuggestion(
  db: Db,
  classId: number,
  input: { concept: string; note: string | null },
): VizSuggestion {
  return db.transaction((tx) => {
    const status = tx
      .select({ status: classTable.status })
      .from(classTable)
      .where(eq(classTable.id, classId))
      .get()?.status;
    if (status !== "ready") throw new ConflictError("The class has no finished lesson");
    const row = tx
      .insert(vizSuggestion)
      .values({
        classId,
        concept: input.concept,
        section: "",
        misconception: input.note ?? "",
        summary: input.note ?? input.concept,
        controlsJson: [],
        scenariosJson: [],
        origin: "user",
      })
      .returning()
      .get();
    return toVizSuggestion(row);
  });
}

/**
 * Marks suggestions of the class as selected. Throws a 400 for ids that do not belong to the
 * class and a 409 for ones already selected; nothing is changed in either case.
 */
export function selectVizSuggestions(db: Db, classId: number, ids: number[]): number[] {
  const unique = [...new Set(ids)];
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(vizSuggestion)
      .where(and(eq(vizSuggestion.classId, classId), inArray(vizSuggestion.id, unique)))
      .all();
    const found = new Set(rows.map((r) => r.id));
    const unknown = unique.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        400,
        "validation",
        `Unknown visualization suggestion ids for this class: ${unknown.join(", ")}`,
      );
    }
    const already = rows.filter((r) => r.selected).map((r) => r.id);
    if (already.length > 0) {
      throw new ConflictError(`Already selected: ${already.join(", ")}`);
    }
    tx.update(vizSuggestion).set({ selected: true }).where(inArray(vizSuggestion.id, unique)).run();
    return unique;
  });
}

/** The class's released visualizations, oldest first. The HTML is never part of the list. */
export function listVisualizations(db: Db, classId: number): VisualizationSummary[] {
  return db
    .select({
      id: visualization.id,
      classId: visualization.classId,
      suggestionId: visualization.suggestionId,
      slug: visualization.slug,
      title: visualization.title,
      createdAt: visualization.createdAt,
    })
    .from(visualization)
    .where(eq(visualization.classId, classId))
    .orderBy(asc(visualization.id))
    .all()
    .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
