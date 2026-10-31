import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { ApiErrorBody, GenerationJob, VizSuggestion } from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentRuntime } from "../agents/runtime.js";
import { StageError } from "../agents/stage.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { vizSuggestionsFixture } from "../agents/testing/viz-fixtures.js";
import { classTable, course, lesson, vizSuggestion } from "../db/schema.js";
import { DOMAIN_EVENTS } from "../pipeline/events.js";
import type { VizAgents } from "../pipeline/viz-branch.js";
import { createTestApp, type TestApp } from "../test/app.js";

let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-viz-routes-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("viz routes", () => {
  let t: TestApp;
  let courseId: number;
  let classId: number;
  let identify: ReturnType<typeof vi.fn<VizAgents["identifyVizTopics"]>>;
  let events: SemanticEvent[];

  const url = (suffix: string, id = classId) => `/api/classes/${id}/${suffix}`;
  const post = (suffix: string, body?: unknown, id = classId) =>
    t.app.inject({
      method: "POST",
      url: url(suffix, id),
      ...(body !== undefined && { payload: body as object }),
    });
  const list = async () => {
    const res = await t.app.inject({ method: "GET", url: url("viz-suggestions") });
    expect(res.statusCode).toBe(200);
    return VizSuggestion.array().parse(res.json());
  };

  function addClass(number: number, status: "draft" | "ready"): number {
    const id = t.handle.db
      .insert(classTable)
      .values({ courseId, number, title: `Predavanje ${number}`, status })
      .returning({ id: classTable.id })
      .get().id;
    if (status === "ready")
      t.handle.db.insert(lesson).values({ classId: id, bodyMd: "Lekcija." }).run();
    return id;
  }

  beforeEach(() => {
    identify = vi.fn<VizAgents["identifyVizTopics"]>(async () => vizSuggestionsFixture());
    t = createTestApp({
      pipeline: {
        quizAutoStart: false,
        vizAutoStart: false,
        vizAgents: { identifyVizTopics: identify },
      },
    });
    events = [];
    t.coordinator!.subscribe((e) => events.push(e));
    courseId = t.handle.db
      .insert(course)
      .values({ name: "Kurs" })
      .returning({ id: course.id })
      .get().id;
    classId = addClass(1, "ready");
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("lists nothing for a class without suggestions and 404s for an unknown class", async () => {
    expect(await list()).toEqual([]);
    const res = await t.app.inject({ method: "GET", url: url("viz-suggestions", 999) });
    expect(res.statusCode).toBe(404);
  });

  it("adds a custom topic and lists agent suggestions before the student's", async () => {
    const res = await post("viz-suggestions", {
      concept: "  CAP teorema ",
      note: "Particija mreže",
    });
    expect(res.statusCode).toBe(201);
    expect(VizSuggestion.parse(res.json())).toMatchObject({
      classId,
      concept: "CAP teorema",
      section: "",
      misconception: "Particija mreže",
      summary: "Particija mreže",
      controls: [],
      scenarios: [],
      origin: "user",
      selected: false,
    });

    // Identify through the regeneration route, after the custom topic was added.
    const regen = await post("viz-topics/regenerate");
    expect(regen.statusCode).toBe(202);
    expect(GenerationJob.parse(regen.json())).toMatchObject({
      kind: "viz_topics",
      status: "running",
    });
    await waitFor(async () => (await list()).length === 3);

    const all = await list();
    expect(all.map((s) => [s.concept, s.origin])).toEqual([
      ["Sharding pod lupom", "agent"],
      ["Lambda u pokretu", "agent"],
      ["CAP teorema", "user"],
    ]);
  });

  it("uses the concept as the summary when the note is missing or blank", async () => {
    const a = await post("viz-suggestions", { concept: "Tema A", note: null });
    expect(VizSuggestion.parse(a.json())).toMatchObject({ misconception: "", summary: "Tema A" });
    const b = await post("viz-suggestions", { concept: "Tema B", note: "   " });
    expect(VizSuggestion.parse(b.json())).toMatchObject({ misconception: "", summary: "Tema B" });
    const c = await post("viz-suggestions", { concept: "Tema C" });
    expect(c.statusCode).toBe(201);
  });

  it("validates a custom topic and requires a ready class", async () => {
    for (const body of [
      {},
      { concept: "" },
      { concept: "x".repeat(201), note: null },
      { concept: "ok", note: "x".repeat(2001) },
      { concept: "ok", extra: 1 },
    ]) {
      const res = await post("viz-suggestions", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe("validation");
    }
    const draft = addClass(2, "draft");
    const res = await post("viz-suggestions", { concept: "Tema", note: null }, draft);
    expect(res.statusCode).toBe(409);
    expect((await post("viz-suggestions", { concept: "Tema", note: null }, 999)).statusCode).toBe(
      404,
    );
  });

  describe("select", () => {
    let ids: number[];

    beforeEach(async () => {
      await post("viz-topics/regenerate");
      await waitFor(async () => (await list()).length === 2);
      ids = (await list()).map((s) => s.id);
    });

    const selectedEvents = () => events.filter((e) => e.type === DOMAIN_EVENTS.VIZ_SELECTED);

    it("marks the suggestions selected, emits viz.selected and returns the list", async () => {
      const res = await post("viz-suggestions/select", { ids: [ids[1]!, ids[1]!] });
      expect(res.statusCode).toBe(200);
      const body = VizSuggestion.array().parse(res.json());
      expect(body.map((s) => [s.id, s.selected])).toEqual([
        [ids[0], false],
        [ids[1], true],
      ]);
      expect(selectedEvents().map((e) => e.payload)).toEqual([
        { classId, suggestionIds: [ids[1]] },
      ]);
    });

    it("rejects invalid bodies and ids of other classes with 400, changing nothing", async () => {
      const other = addClass(2, "ready");
      const foreign = t.handle.db
        .insert(vizSuggestion)
        .values({
          classId: other,
          concept: "Tuđa",
          section: "",
          misconception: "",
          summary: "Tuđa",
          controlsJson: [],
          scenariosJson: [],
          origin: "user",
        })
        .returning({ id: vizSuggestion.id })
        .get().id;
      for (const body of [
        {},
        { ids: [] },
        { ids: [0] },
        { ids: ["1"] },
        { ids: [ids[0]!, 9999] },
        { ids: [foreign] },
      ]) {
        const res = await post("viz-suggestions/select", body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(ApiErrorBody.parse(res.json()).error.code).toBe("validation");
      }
      expect((await list()).every((s) => !s.selected)).toBe(true);
      expect(selectedEvents()).toHaveLength(0);
    });

    it("answers 409 for an already selected suggestion and changes nothing", async () => {
      expect((await post("viz-suggestions/select", { ids: [ids[0]!] })).statusCode).toBe(200);
      const res = await post("viz-suggestions/select", { ids: [ids[1]!, ids[0]!] });
      expect(res.statusCode).toBe(409);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe("conflict");
      expect((await list()).map((s) => s.selected)).toEqual([true, false]);
      expect(selectedEvents()).toHaveLength(1);
    });

    it("answers 404 for an unknown class", async () => {
      expect((await post("viz-suggestions/select", { ids: [1] }, 999)).statusCode).toBe(404);
    });
  });

  describe("regenerate", () => {
    it("answers 404, and 409 while running or after success", async () => {
      expect((await post("viz-topics/regenerate", undefined, 999)).statusCode).toBe(404);
      let release!: () => void;
      identify.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(vizSuggestionsFixture()))),
      );
      expect((await post("viz-topics/regenerate")).statusCode).toBe(202);
      expect((await post("viz-topics/regenerate")).statusCode).toBe(409);
      release();
      await waitFor(async () => (await list()).length === 2);
      const res = await post("viz-topics/regenerate");
      expect(res.statusCode).toBe(409);
      expect(ApiErrorBody.parse(res.json()).error.code).toBe("conflict");
    });

    it("is allowed again after a failure", async () => {
      identify.mockRejectedValueOnce(new StageError("failed", "api down"));
      expect((await post("viz-topics/regenerate")).statusCode).toBe(202);
      await waitFor(async () => {
        const jobs = await t.app.inject({ method: "GET", url: url("jobs") });
        return (jobs.json() as { jobs: { status: string }[] }).jobs[0]?.status === "failed";
      });
      const res = await post("viz-topics/regenerate");
      expect(res.statusCode).toBe(202);
      expect(GenerationJob.parse(res.json()).attempt).toBe(2);
    });
  });
});
