import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { and, eq } from "drizzle-orm";
import type { PipelineEvent, VizDraft, VizPlan } from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentRuntime } from "../agents/runtime.js";
import { StageError, type StageSession } from "../agents/stage.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import {
  VIZ_APPROVED,
  VIZ_HTML,
  VIZ_REJECTED,
  vizDraftFixture,
  vizPlanFixture,
} from "../agents/testing/viz-build-fixtures.js";
import {
  classTable,
  course,
  generationJob,
  lesson,
  visualization,
  vizBuild,
  vizSuggestion,
} from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { DOMAIN_EVENTS, type VizReleasedPayload } from "./events.js";
import type { VizAgents } from "./viz-branch.js";

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-viz-build-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

const FIXED: VizDraft = vizDraftFixture({
  html: VIZ_HTML.replace("Čvor dodat", "Čvor dodat i ključevi su premešteni"),
  notes: ["Ispravljeno."],
});

/** A plan per concept, so that two jobs in one test are told apart. */
const planFor = (concept: string, overrides: Partial<VizPlan> = {}): VizPlan =>
  vizPlanFixture({
    concept,
    title: concept,
    slug: concept.toLowerCase().replace(/\s+/g, "-"),
    ...overrides,
  });

describe("viz build jobs", () => {
  let t: TestApp;
  let classId: number;
  let events: SemanticEvent[];
  let plan: ReturnType<typeof vi.fn<VizAgents["planViz"]>>;
  let review: ReturnType<typeof vi.fn<VizAgents["reviewViz"]>>;
  let send: ReturnType<typeof vi.fn<(message: string) => Promise<VizDraft>>>;
  let close: ReturnType<typeof vi.fn<() => void>>;
  let open: ReturnType<typeof vi.fn<VizAgents["openVizBuilderSession"]>>;

  const db = () => t.handle.db;
  const vizJobs = () =>
    db().select().from(generationJob).where(eq(generationJob.kind, "viz")).all();
  const jobOf = (suggestionId: number) => vizJobs().filter((j) => j.suggestionId === suggestionId);
  const visualizations = () => db().select().from(visualization).all();
  const classStatus = () =>
    db().select().from(classTable).where(eq(classTable.id, classId)).get()!.status;
  const types = () => events.map((e) => e.type);
  const settled = (n: number) =>
    vizJobs().length >= n && vizJobs().every((j) => j.status !== "running");
  const jobUpdates = (suggestionId: number) =>
    events
      .filter((e) => e.type === DOMAIN_EVENTS.JOB_UPDATED)
      .map((e) => (e.payload as Extract<PipelineEvent, { type: "job" }>).job)
      .filter((j) => j.kind === "viz" && j.suggestionId === suggestionId);

  function addSuggestion(concept: string, over: Partial<typeof vizSuggestion.$inferInsert> = {}) {
    return db()
      .insert(vizSuggestion)
      .values({
        classId,
        concept,
        section: "Obrada podataka › Batch obrada",
        misconception: "Pogrešan model.",
        summary: "Sažetak.",
        controlsJson: ["klizač"],
        scenariosJson: ["scenario"],
        origin: "agent",
        selected: true,
        ...over,
      })
      .returning({ id: vizSuggestion.id })
      .get().id;
  }

  function select(...suggestionIds: number[]): void {
    t.coordinator!.emit(DOMAIN_EVENTS.VIZ_SELECTED, { classId, suggestionIds });
  }

  beforeEach(() => {
    plan = vi.fn<VizAgents["planViz"]>(async ({ suggestion }) => planFor(suggestion.concept));
    review = vi.fn<VizAgents["reviewViz"]>(async () => VIZ_APPROVED);
    send = vi.fn(async () => vizDraftFixture());
    close = vi.fn();
    open = vi.fn<VizAgents["openVizBuilderSession"]>(
      () => ({ send, close }) as unknown as StageSession<VizDraft>,
    );
    t = createTestApp({
      pipeline: {
        writeLesson: async () => {
          throw new Error("not used");
        },
        quizAutoStart: false,
        vizAutoStart: false,
        vizAgents: { planViz: plan, openVizBuilderSession: open, reviewViz: review },
      },
    });
    events = [];
    t.coordinator!.subscribe((e) => events.push(e));

    const courseId = db()
      .insert(course)
      .values({ name: "Kurs", persona: "iskusni inženjer" })
      .returning({ id: course.id })
      .get().id;
    classId = db()
      .insert(classTable)
      .values({ courseId, number: 2, title: "Obrada podataka", status: "ready" })
      .returning({ id: classTable.id })
      .get().id;
    db().insert(lesson).values({ classId, bodyMd: "## Batch obrada\n\n- Lekcija." }).run();
    db()
      .insert(generationJob)
      .values({
        classId,
        kind: "lesson",
        stage: "lesson-writer",
        status: "succeeded",
        attempt: 1,
        finishedAt: new Date(),
      })
      .run();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("builds a selected suggestion and releases the visualization with its build log", async () => {
    const topicsJob = db()
      .insert(generationJob)
      .values({
        classId,
        kind: "viz_topics",
        stage: "viz-identifier",
        status: "succeeded",
        attempt: 1,
        finishedAt: new Date(),
      })
      .returning({ id: generationJob.id })
      .get().id;
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => types().includes(DOMAIN_EVENTS.VIZ_RELEASED));

    const [job] = jobOf(id);
    expect(job).toMatchObject({
      kind: "viz",
      status: "succeeded",
      attempt: 1,
      error: null,
      cycle: 1,
      parentJobId: topicsJob,
      suggestionId: id,
    });
    expect(job!.finishedAt).not.toBeNull();
    expect(classStatus()).toBe("ready");

    const [viz] = visualizations();
    expect(viz).toMatchObject({
      classId,
      suggestionId: id,
      slug: "sharding-pod-lupom",
      title: "Sharding pod lupom",
      html: VIZ_HTML,
      jobId: job!.id,
    });
    expect(events.at(-1)!.payload as VizReleasedPayload).toEqual({
      classId,
      visualizationId: viz!.id,
      suggestionId: id,
    });

    const [build] = db().select().from(vizBuild).all();
    expect(build).toMatchObject({
      jobId: job!.id,
      suggestionId: id,
      draftHtml: VIZ_HTML,
      visualizationId: viz!.id,
    });
    expect(build!.planJson).toEqual(planFor("Sharding pod lupom"));
    expect(build!.logJson).toEqual([
      { cycle: 1, report: { errors: [], warnings: [] }, review: VIZ_APPROVED, notes: [] },
    ]);

    // planner -> builder -> reviewer (cycle 1) -> succeeded, in that order
    expect(jobUpdates(id).map((j) => [j.status, j.stage, j.cycle])).toEqual([
      ["running", "viz-planner", null],
      ["running", "viz-builder", null],
      ["running", "viz-reviewer", 1],
      ["succeeded", "viz-reviewer", 1],
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    // the planner got the class context and the suggestion; the builder got the plan and lesson
    const [plannerInput] = plan.mock.calls[0]!;
    expect(plannerInput.ctx.class.id).toBe(classId);
    expect(plannerInput.suggestion).toMatchObject({
      concept: "Sharding pod lupom",
      origin: "agent",
    });
    expect(send.mock.calls[0]![0]).toContain("Lekcija.");
    expect(review.mock.calls[0]![0]).toMatchObject({ html: VIZ_HTML, notes: [] });
  });

  it("runs the jobs of several suggestions concurrently", async () => {
    const a = addSuggestion("Prva tema");
    const b = addSuggestion("Druga tema");
    let started = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    plan.mockImplementation(async ({ suggestion }) => {
      started++;
      if (started === 2) openGate();
      // A serial implementation would never get the second planner started: this would time out.
      await gate;
      return planFor(suggestion.concept);
    });
    select(a, b);
    await waitFor(() => settled(2));

    expect(started).toBe(2);
    expect(
      visualizations()
        .map((v) => v.slug)
        .sort(),
    ).toEqual(["druga-tema", "prva-tema"]);
    expect(vizJobs().map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    expect(types().filter((x) => x === DOMAIN_EVENTS.VIZ_RELEASED)).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("repairs through fix rounds on the same builder session", async () => {
    review.mockResolvedValueOnce(VIZ_REJECTED).mockResolvedValueOnce(VIZ_APPROVED);
    send.mockResolvedValueOnce(vizDraftFixture()).mockResolvedValueOnce(FIXED);
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => settled(1));

    expect(jobOf(id)[0]!.status).toBe("succeeded");
    expect(open).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    const fixMessage = send.mock.calls[1]![0];
    expect(fixMessage).toContain("scenario: Ispad čvora");
    expect(fixMessage).toContain("Premesti samo ključeve čvora 2.");
    expect(review.mock.calls[1]![0].html).toBe(FIXED.html);
    expect(review.mock.calls[1]![0].notes).toEqual(["Ispravljeno."]);
    expect(visualizations()[0]!.html).toBe(FIXED.html);

    const [build] = db().select().from(vizBuild).all();
    expect(build!.logJson.map((e) => [e.cycle, e.review?.approved])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(jobUpdates(id).map((j) => [j.stage, j.cycle])).toEqual([
      ["viz-planner", null],
      ["viz-builder", null],
      ["viz-reviewer", 1],
      ["viz-builder", 1],
      ["viz-reviewer", 2],
      ["viz-reviewer", 2],
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails after 3 fix cycles (4 reviews) while the other job still releases", async () => {
    const bad = addSuggestion("Loša tema");
    const good = addSuggestion("Dobra tema");
    review.mockImplementation(async ({ plan: p }) =>
      p.concept === "Loša tema" ? VIZ_REJECTED : VIZ_APPROVED,
    );
    select(bad, good);
    await waitFor(() => settled(2));

    const [failed] = jobOf(bad);
    expect(failed).toMatchObject({ status: "failed", stage: "viz-reviewer", cycle: 4 });
    expect(failed!.error).toBe(
      `Viz review did not pass after 3 fix cycles: ${VIZ_REJECTED.summary}`,
    );
    expect(jobOf(good)[0]).toMatchObject({ status: "succeeded", error: null });

    const reviewsOfBad = review.mock.calls.filter(([i]) => i.plan.concept === "Loša tema");
    expect(reviewsOfBad).toHaveLength(4);
    // 1 build + 3 fix rounds for the bad job, 1 build for the good one
    expect(send).toHaveBeenCalledTimes(5);
    expect(close).toHaveBeenCalledTimes(2);

    expect(visualizations().map((v) => v.suggestionId)).toEqual([good]);
    const failedBuild = db().select().from(vizBuild).where(eq(vizBuild.suggestionId, bad)).get()!;
    expect(failedBuild.visualizationId).toBeNull();
    expect(failedBuild.logJson).toHaveLength(4);
    expect(failedBuild.draftHtml).toBe(VIZ_HTML);
    expect(classStatus()).toBe("ready");
    expect(types().filter((x) => x === DOMAIN_EVENTS.VIZ_RELEASED)).toHaveLength(1);
  });

  it("fails the job on a planner error without opening a builder session", async () => {
    plan.mockRejectedValueOnce(new StageError("failed", "api down"));
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => settled(1));

    expect(jobOf(id)[0]).toMatchObject({
      status: "failed",
      stage: "viz-planner",
      error: "Viz planner failed (failed): api down",
    });
    expect(open).not.toHaveBeenCalled();
    expect(db().select().from(vizBuild).all()).toHaveLength(0);
    expect(visualizations()).toHaveLength(0);
    expect(classStatus()).toBe("ready");
  });

  it("fails the job on a builder error and closes the session", async () => {
    send.mockRejectedValueOnce(new StageError("schema", "bad page"));
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => settled(1));

    expect(jobOf(id)[0]).toMatchObject({
      status: "failed",
      stage: "viz-builder",
      error: "Viz builder failed (schema): bad page",
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
  });

  it("fails the job on a reviewer error", async () => {
    review.mockRejectedValueOnce(new Error("boom"));
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => settled(1));
    expect(jobOf(id)[0]).toMatchObject({
      status: "failed",
      stage: "viz-reviewer",
      error: "Viz reviewer failed: boom",
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("sends contract errors back to the builder without asking the reviewer", async () => {
    const broken = vizDraftFixture({
      html: VIZ_HTML.replace("<script>", '<script src="x.js"></script><script>'),
    });
    send.mockResolvedValueOnce(broken).mockResolvedValueOnce(vizDraftFixture());
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => settled(1));

    expect(jobOf(id)[0]!.status).toBe("succeeded");
    expect(review).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]![0]).toContain("[external_script]");
    const [build] = db().select().from(vizBuild).all();
    expect(build!.logJson[0]!.report.errors.map((e) => e.code)).toEqual(["external_script"]);
    expect(build!.logJson[0]!.review!.approved).toBe(false);
  });

  it("appends -2 and -3 to the slug of a visualization that collides in its class", async () => {
    const ids = [addSuggestion("Prva"), addSuggestion("Druga"), addSuggestion("Treća")];
    plan.mockImplementation(async ({ suggestion }) =>
      planFor(suggestion.concept, { slug: "isti-slug" }),
    );
    // sequential selections so that the order of the releases is defined
    for (const [i, id] of ids.entries()) {
      select(id);
      await waitFor(() => settled(i + 1));
    }
    expect(visualizations().map((v) => [v.suggestionId, v.slug])).toEqual([
      [ids[0], "isti-slug"],
      [ids[1], "isti-slug-2"],
      [ids[2], "isti-slug-3"],
    ]);
  });

  it("starts jobs only for selected suggestions of the class that have none yet", async () => {
    const other = db()
      .insert(classTable)
      .values({ courseId: 1, number: 3, title: "Druga", status: "ready" })
      .returning({ id: classTable.id })
      .get().id;
    const foreign = db()
      .insert(vizSuggestion)
      .values({
        classId: other,
        concept: "Tuđa",
        section: "",
        misconception: "",
        summary: "",
        controlsJson: [],
        scenariosJson: [],
        origin: "user",
        selected: true,
      })
      .returning({ id: vizSuggestion.id })
      .get().id;
    const unselected = addSuggestion("Neizabrana", { selected: false });
    const ok = addSuggestion("Izabrana");
    select(foreign, unselected, 9999, ok, ok);
    await waitFor(() => settled(1));
    await new Promise((r) => setTimeout(r, 30));

    expect(vizJobs().map((j) => j.suggestionId)).toEqual([ok]);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("plans a user topic from its concept and note", async () => {
    const id = addSuggestion("CAP teorema", {
      origin: "user",
      section: "",
      misconception: "Particija mreže",
      summary: "Particija mreže",
      controlsJson: [],
      scenariosJson: [],
    });
    select(id);
    await waitFor(() => settled(1));
    expect(plan.mock.calls[0]![0].suggestion).toMatchObject({
      concept: "CAP teorema",
      origin: "user",
      misconception: "Particija mreže",
    });
    expect(jobOf(id)[0]!.status).toBe("succeeded");
  });

  it("deleting the class removes its jobs, builds and visualizations", async () => {
    const id = addSuggestion("Sharding pod lupom");
    select(id);
    await waitFor(() => settled(1));
    expect(visualizations()).toHaveLength(1);
    db().delete(classTable).where(eq(classTable.id, classId)).run();
    expect(visualizations()).toHaveLength(0);
    expect(db().select().from(vizBuild).all()).toHaveLength(0);
    expect(vizJobs()).toHaveLength(0);
  });

  describe("requestVizRegeneration", () => {
    async function failedSuggestion(): Promise<number> {
      plan.mockRejectedValueOnce(new StageError("failed", "api down"));
      const id = addSuggestion("Sharding pod lupom");
      select(id);
      await waitFor(() => settled(1));
      return id;
    }

    it("rebuilds from scratch as attempt 2 after a failure, with the failed job as parent", async () => {
      const id = await failedSuggestion();
      const failedId = jobOf(id)[0]!.id;
      const job = t.pipeline!.requestVizRegeneration(id);
      expect(job).toMatchObject({
        kind: "viz",
        status: "running",
        attempt: 2,
        suggestionId: id,
        stage: "viz-planner",
      });
      await waitFor(() => settled(2));
      expect(jobOf(id).map((j) => [j.status, j.parentJobId])).toEqual([
        ["failed", expect.any(Number)],
        ["succeeded", failedId],
      ]);
      expect(plan).toHaveBeenCalledTimes(2);
      expect(visualizations()).toHaveLength(1);
    });

    it("also works for a selected suggestion that never got a job", async () => {
      const id = addSuggestion("Starija tema");
      const job = t.pipeline!.requestVizRegeneration(id);
      expect(job).toMatchObject({ attempt: 1, suggestionId: id });
      await waitFor(() => settled(1));
      expect(visualizations()).toHaveLength(1);
    });

    it("is refused with 409 while running and after success", async () => {
      let release!: () => void;
      plan.mockImplementationOnce(
        ({ suggestion }) =>
          new Promise((resolve) => {
            release = () => resolve(planFor(suggestion.concept));
          }),
      );
      const id = addSuggestion("Sharding pod lupom");
      select(id);
      await waitFor(() => jobOf(id).length === 1);
      expect(() => t.pipeline!.requestVizRegeneration(id)).toThrow(/already being built/);
      release();
      await waitFor(() => settled(1));
      expect(() => t.pipeline!.requestVizRegeneration(id)).toThrow(/already exists/);
    });

    it("is refused when the suggestion is not selected, and 404 when it does not exist", () => {
      const id = addSuggestion("Neizabrana", { selected: false });
      expect(() => t.pipeline!.requestVizRegeneration(id)).toThrow(/not selected/);
      expect(() => t.pipeline!.requestVizRegeneration(9999)).toThrow(/not found/);
    });

    it("is refused when a visualization was released although the latest job failed", async () => {
      const id = await failedSuggestion();
      db()
        .insert(visualization)
        .values({ classId, suggestionId: id, slug: "x", title: "X Y", html: VIZ_HTML })
        .run();
      expect(() => t.pipeline!.requestVizRegeneration(id)).toThrow(/already exists/);
    });

    it("keeps each suggestion's attempts apart", async () => {
      const a = await failedSuggestion();
      const b = addSuggestion("Druga tema");
      select(b);
      await waitFor(() => settled(2));
      expect(jobOf(b)[0]!.attempt).toBe(1);
      expect(t.pipeline!.requestVizRegeneration(a).attempt).toBe(2);
      await waitFor(() => settled(3));
      expect(
        db()
          .select()
          .from(generationJob)
          .where(and(eq(generationJob.kind, "viz"), eq(generationJob.suggestionId, b)))
          .all(),
      ).toHaveLength(1);
    });
  });
});
