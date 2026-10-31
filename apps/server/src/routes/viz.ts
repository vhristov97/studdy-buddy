import type { FastifyPluginAsync } from "fastify";
import {
  CreateVizSuggestionInput,
  SelectVizSuggestionsInput,
  type CourseVisualization,
  type VisualizationDetail,
  type VisualizationSummary,
  type VizSuggestion,
} from "@studdy/shared";
import type { Coordinator } from "../agents/coordinator.js";
import type { Db } from "../db/client.js";
import { DOMAIN_EVENTS, type VizSelectedPayload } from "../pipeline/events.js";
import { getCourse } from "../repositories/courses.js";
import { getClassStatus } from "../repositories/lessons.js";
import {
  addUserVizSuggestion,
  getVisualizationDetail,
  getVisualizationHtml,
  listCourseVisualizations,
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

/**
 * Visualizations are model-written pages, so they run in a sandbox (opaque origin, so no access
 * to the app's cookies, storage or API) with no network access of any kind.
 *
 * CSP has no reliable directive that stops a page from navigating its own frame (a plain
 * `<a href="https://...">` click), so `validateVizHtml` rejecting external links and navigation
 * APIs is the main guard; the sandbox (no allow-top-navigation / allow-popups) and
 * `form-action 'none'` are defense in depth.
 */
export const VIZ_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

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

  app.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/visualizations",
    async (request): Promise<CourseVisualization[]> => {
      const courseId = parseId("courseId", request.params.courseId);
      if (!getCourse(db, courseId)) throw notFound("Course");
      return listCourseVisualizations(db, courseId);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/visualizations/:id",
    async (request): Promise<VisualizationDetail> => {
      const found = getVisualizationDetail(db, parseId("id", request.params.id));
      if (!found) throw notFound("Visualization");
      return found;
    },
  );

  // Outside /api: this is the page itself, loaded in a sandboxed iframe or its own window.
  app.get<{ Params: { id: string } }>("/viz/:id", async (request, reply) => {
    // A malformed id is just a page that does not exist.
    const id = /^\d+$/.test(request.params.id) ? Number(request.params.id) : 0;
    const html = getVisualizationHtml(db, id);
    if (html === undefined) throw notFound("Visualization");
    return reply.headers(VIZ_PAGE_HEADERS).send(html);
  });

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
