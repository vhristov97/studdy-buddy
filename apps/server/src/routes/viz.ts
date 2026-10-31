import type { FastifyPluginAsync } from "fastify";
import {
  CreateVizSuggestionInput,
  SelectVizSuggestionsInput,
  type VisualizationSummary,
  type VizSuggestion,
} from "@studdy/shared";
import type { Coordinator } from "../agents/coordinator.js";
import type { Db } from "../db/client.js";
import { DOMAIN_EVENTS, type VizSelectedPayload } from "../pipeline/events.js";
import { getClassStatus } from "../repositories/lessons.js";
import {
  addUserVizSuggestion,
  listVisualizations,
  listVizSuggestions,
  selectVizSuggestions,
} from "../repositories/viz.js";
import { notFound, parseBody, parseId } from "./errors.js";

export interface VizRouteOptions {
  db: Db;
  /** Without it, selecting works but no `viz.selected` event is emitted. */
  coordinator?: Coordinator;
}

interface ClassParams {
  classId: string;
}

export const vizRoutes: FastifyPluginAsync<VizRouteOptions> = async (app, { db, coordinator }) => {
  function requireClass(rawId: string): number {
    const classId = parseId("classId", rawId);
    if (getClassStatus(db, classId) === undefined) throw notFound("Class");
    return classId;
  }

  app.get<{ Params: ClassParams }>(
    "/api/classes/:classId/viz-suggestions",
    async (request): Promise<VizSuggestion[]> =>
      listVizSuggestions(db, requireClass(request.params.classId)),
  );

  app.get<{ Params: ClassParams }>(
    "/api/classes/:classId/visualizations",
    async (request): Promise<VisualizationSummary[]> =>
      listVisualizations(db, requireClass(request.params.classId)),
  );

  app.post<{ Params: ClassParams }>(
    "/api/classes/:classId/viz-suggestions",
    async (request, reply): Promise<VizSuggestion> => {
      const classId = requireClass(request.params.classId);
      const input = parseBody(CreateVizSuggestionInput, request.body);
      return reply.code(201).send(addUserVizSuggestion(db, classId, input));
    },
  );

  app.post<{ Params: ClassParams }>(
    "/api/classes/:classId/viz-suggestions/select",
    async (request): Promise<VizSuggestion[]> => {
      const classId = requireClass(request.params.classId);
      const { ids } = parseBody(SelectVizSuggestionsInput, request.body);
      const suggestionIds = selectVizSuggestions(db, classId, ids);
      if (coordinator) {
        const payload: VizSelectedPayload = { classId, suggestionIds };
        try {
          coordinator.emit(DOMAIN_EVENTS.VIZ_SELECTED, payload);
        } catch (err) {
          // The selection is saved; a missing event must not fail the student's request.
          request.log.error({ err, ...payload }, "could not emit viz.selected");
        }
      }
      return listVizSuggestions(db, classId);
    },
  );
};
