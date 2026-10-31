import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type {
  ClassDetail,
  CourseDetail,
  CourseSummary,
  GenerationJob,
  LessonView,
  MaterialDetail,
  MaterialSummary,
  TopicEvent,
  TopicView,
} from "@studdy/shared";
import { App } from "../App";

export function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: BodyInit | null | undefined;
  headers: Headers;
}

export type Handler = (req: RecordedRequest) => Response | object | undefined | Promise<unknown>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function apiError(status: number, code: string, message: string, details?: unknown) {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

/**
 * Stubs fetch with route handlers keyed "METHOD /path". A handler may return a Response, a plain
 * object (sent as 200 JSON) or undefined (204). Unknown routes answer 404; /api/health is up.
 */
export function mockApi(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: RecordedRequest = {
      method: init?.method ?? "GET",
      path: String(input),
      body: init?.body,
      headers: new Headers(init?.headers),
    };
    requests.push(req);
    const handler = routes[`${req.method} ${req.path}`];
    if (!handler) {
      if (req.path === "/api/health") return json({ status: "ok", db: "ok" });
      return apiError(404, "not_found", "Not found");
    }
    const result = await handler(req);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return json(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

// Fixtures

export const course = (over: Partial<CourseSummary> = {}): CourseSummary => ({
  id: 1,
  name: "ASVSP",
  persona: null,
  assessmentFormat: null,
  reviewCadence: null,
  classCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

export const courseDetail = (over: Partial<CourseDetail> = {}): CourseDetail => ({
  ...course(),
  classes: [],
  ...over,
});

export const classDetail = (over: Partial<ClassDetail> = {}): ClassDetail => ({
  id: 5,
  courseId: 1,
  number: 1,
  title: "Uvod",
  status: "draft",
  materialCount: 0,
  noteCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  courseName: "ASVSP",
  materials: [],
  ...over,
});

export const material = (over: Partial<MaterialSummary> = {}): MaterialSummary => ({
  id: 10,
  classId: 5,
  kind: "material",
  originalName: "uvod.pdf",
  mime: "application/pdf",
  sizeBytes: 1_572_864,
  extractionStatus: "ok",
  extractionError: null,
  pageCount: 12,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

export const materialDetail = (over: Partial<MaterialDetail> = {}): MaterialDetail => ({
  ...material(),
  extractedText: null,
  ...over,
});

export const job = (over: Partial<GenerationJob> = {}): GenerationJob => ({
  id: 1,
  classId: 5,
  kind: "lesson",
  stage: "lesson-writer",
  status: "running",
  attempt: 1,
  error: null,
  cycle: null,
  submissionId: null,
  createdAt: "2026-01-01T10:00:00.000Z",
  finishedAt: null,
  ...over,
});

export const topicEvent = (over: Partial<TopicEvent> = {}): TopicEvent => ({
  id: 1,
  source: "notes",
  ref: null,
  outcome: null,
  misconceptionText: null,
  correctionText: null,
  createdAt: "2026-01-01T10:05:00.000Z",
  ...over,
});

export const topic = (over: Partial<TopicView> = {}): TopicView => ({
  id: 1,
  name: "Veliki podaci",
  position: 0,
  rating: "?",
  deferred: false,
  deferredNote: null,
  events: [],
  ...over,
});

export const lessonView = (over: Partial<LessonView> = {}): LessonView => ({
  classId: 5,
  bodyMd: "## Uvod\n\n- (P) Predavač je rekao da je to važno.\n",
  createdAt: "2026-01-01T10:05:00.000Z",
  topics: [topic()],
  ...over,
});
