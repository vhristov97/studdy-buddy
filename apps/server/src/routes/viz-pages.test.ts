import { CourseVisualization, VisualizationDetail } from "@studdy/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classTable, course, visualization, vizSuggestion } from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { VIZ_PAGE_HEADERS } from "./viz.js";

const PAGE = "<!doctype html><title>Sharding</title><script>document.title = 'x'</script>";

describe("visualization pages and details", () => {
  let t: TestApp;
  let courseId: number;
  let classId: number;
  let suggestionId: number;
  let vizId: number;

  beforeEach(() => {
    t = createTestApp();
    const db = t.handle.db;
    courseId = db.insert(course).values({ name: "ASVSP" }).returning({ id: course.id }).get().id;
    classId = db
      .insert(classTable)
      .values({ courseId, number: 2, title: "Kontejneri", status: "ready" })
      .returning({ id: classTable.id })
      .get().id;
    suggestionId = db
      .insert(vizSuggestion)
      .values({
        classId,
        concept: "Sharding",
        section: "1.2",
        misconception: "Shard je kopija",
        summary: "Raspodela podataka",
        controlsJson: [],
        scenariosJson: [],
        origin: "agent",
      })
      .returning({ id: vizSuggestion.id })
      .get().id;
    vizId = db
      .insert(visualization)
      .values({ classId, suggestionId, slug: "sharding", title: "Sharding pod lupom", html: PAGE })
      .returning({ id: visualization.id })
      .get().id;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("serves the stored page with the sandbox headers", async () => {
    const res = await t.app.inject({ method: "GET", url: `/viz/${vizId}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PAGE);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toBe(VIZ_PAGE_HEADERS["content-security-policy"]);
    for (const part of [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "connect-src 'none'",
      "frame-ancestors 'self'",
      "sandbox allow-scripts",
    ]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toContain("allow-same-origin");
  });

  it("answers 404 for an unknown visualization", async () => {
    const res = await t.app.inject({ method: "GET", url: "/viz/9999" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("<script");
  });

  it("returns the detail with context and without the HTML", async () => {
    const res = await t.app.inject({ method: "GET", url: `/api/visualizations/${vizId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("html");
    expect(VisualizationDetail.parse(res.json())).toMatchObject({
      id: vizId,
      classId,
      suggestionId,
      title: "Sharding pod lupom",
      className: "Kontejneri",
      classNumber: 2,
      courseId,
      courseName: "ASVSP",
      concept: "Sharding",
      misconception: "Shard je kopija",
    });
    expect(
      (await t.app.inject({ method: "GET", url: "/api/visualizations/9999" })).statusCode,
    ).toBe(404);
  });

  it("has null concept and misconception when the suggestion is gone", async () => {
    t.handle.db.delete(vizSuggestion).run();
    const res = await t.app.inject({ method: "GET", url: `/api/visualizations/${vizId}` });
    expect(VisualizationDetail.parse(res.json())).toMatchObject({
      suggestionId: null,
      concept: null,
      misconception: null,
    });
  });

  it("lists the visualizations of a course with their class", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/courses/${courseId}/visualizations`,
    });
    expect(res.statusCode).toBe(200);
    const list = CourseVisualization.array().parse(res.json());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: vizId, classNumber: 2, className: "Kontejneri" });
    expect(list[0]).not.toHaveProperty("html");
    expect(
      (await t.app.inject({ method: "GET", url: "/api/courses/9999/visualizations" })).statusCode,
    ).toBe(404);
  });
});
