import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { eq } from "drizzle-orm";
import type { PipelineEvent } from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentRuntime } from "../agents/runtime.js";
import { StageError } from "../agents/stage.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { vizSuggestionsFixture } from "../agents/testing/viz-fixtures.js";
import {
  classTable,
  course,
  generationJob,
  lesson,
  topic,
  topicEvent,
  vizSuggestion,
} from "../db/schema.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { DOMAIN_EVENTS } from "./events.js";
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
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-viz-branch-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("viz branch", () => {
  let t: TestApp;
  let classId: number;
  let events: SemanticEvent[];
  let identify: ReturnType<typeof vi.fn<VizAgents["identifyVizTopics"]>>;

  const db = () => t.handle.db;
  const vizJobs = () =>
    db().select().from(generationJob).where(eq(generationJob.kind, "viz_topics")).all();
  const classStatus = () =>
    db().select().from(classTable).where(eq(classTable.id, classId)).get()!.status;
  const suggestions = () => db().select().from(vizSuggestion).all();
  const finished = (n = 1) =>
    vizJobs().length >= n && vizJobs().every((j) => j.status !== "running");

  function startBranch(): void {
    t.coordinator!.emit(DOMAIN_EVENTS.LESSON_READY, { classId, lessonId: 1 });
  }

  /** Fails the first job so that a regeneration may be requested. */
  async function failFirstJob(): Promise<void> {
    identify.mockRejectedValueOnce(new StageError("failed", "api down"));
    startBranch();
    await waitFor(() => finished(1));
  }

  beforeEach(() => {
    identify = vi.fn<VizAgents["identifyVizTopics"]>(async () => vizSuggestionsFixture());
    t = createTestApp({
      pipeline: {
        writeLesson: async () => {
          throw new Error("not used");
        },
        quizAutoStart: false,
        vizAgents: { identifyVizTopics: identify },
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
    const topicId = db()
      .insert(topic)
      .values({ courseId, classId, name: "Batch obrada", position: 0 })
      .returning({ id: topic.id })
      .get().id;
    db()
      .insert(topicEvent)
      .values({ topicId, source: "notes", outcome: "misconception", misconceptionText: "Zabluda" })
      .run();
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

  it("identifies topics on lesson.ready and stores the suggestions", async () => {
    startBranch();
    await waitFor(() => finished(1));

    const [job] = vizJobs();
    const lessonJob = db()
      .select()
      .from(generationJob)
      .where(eq(generationJob.kind, "lesson"))
      .get()!;
    expect(job).toMatchObject({
      status: "succeeded",
      stage: "viz-identifier",
      attempt: 1,
      parentJobId: lessonJob.id,
      error: null,
    });
    expect(job!.finishedAt).not.toBeNull();

    const rows = suggestions();
    expect(rows.map((r) => [r.concept, r.origin, r.selected, r.jobId])).toEqual([
      ["Sharding pod lupom", "agent", false, job!.id],
      ["Lambda u pokretu", "agent", false, job!.id],
    ]);
    expect(rows[0]!.controlsJson).toHaveLength(2);
    expect(classStatus()).toBe("ready");

    // The identifier got the class context and the existing topics (none yet).
    const [input] = identify.mock.calls[0]!;
    expect(input.ctx.class.id).toBe(classId);
    expect(input.ctx.topics[0]!.history[0]!.misconception).toBe("Zabluda");
    expect(input.existing).toEqual([]);

    const updates = events
      .filter((e) => e.type === DOMAIN_EVENTS.JOB_UPDATED)
      .map((e) => (e.payload as Extract<PipelineEvent, { type: "job" }>).job)
      .filter((j) => j.kind === "viz_topics");
    expect(updates.map((j) => j.status)).toEqual(["running", "succeeded"]);
  });

  it("does not start on lesson.ready when autoStart is off", async () => {
    await t.cleanup();
    t = createTestApp({
      pipeline: {
        quizAutoStart: false,
        vizAutoStart: false,
        vizAgents: { identifyVizTopics: identify },
      },
    });
    const courseId = db()
      .insert(course)
      .values({ name: "K" })
      .returning({ id: course.id })
      .get().id;
    classId = db()
      .insert(classTable)
      .values({ courseId, number: 1, title: "A", status: "ready" })
      .returning({ id: classTable.id })
      .get().id;
    startBranch();
    await new Promise((r) => setTimeout(r, 30));
    expect(vizJobs()).toHaveLength(0);
    expect(identify).not.toHaveBeenCalled();
  });

  it("emits throttled progress events for the identifier stage", async () => {
    identify.mockImplementationOnce(async (_input, opts) => {
      const delta = {
        type: "inference.stream",
        payload: { type: "content_block_delta", delta: { type: "text_delta", text: "abc" } },
      } as unknown as SemanticEvent;
      opts?.onEvent?.(delta);
      return vizSuggestionsFixture();
    });
    startBranch();
    await waitFor(() => finished(1));
    const progress = events.filter((e) => e.type === DOMAIN_EVENTS.JOB_PROGRESS);
    expect(progress.map((e) => e.payload)).toEqual([
      {
        type: "progress",
        classId,
        jobId: vizJobs()[0]!.id,
        stage: "viz-identifier",
        outputChars: 3,
      },
    ]);
  });

  it("fails the job but leaves the class ready and the suggestions empty on an agent error", async () => {
    await failFirstJob();
    const [job] = vizJobs();
    expect(job!.status).toBe("failed");
    expect(job!.error).toMatch(/^Viz topic identifier failed \(failed\)/);
    expect(suggestions()).toHaveLength(0);
    expect(classStatus()).toBe("ready");
  });

  describe("requestVizTopicsRegeneration", () => {
    it("is allowed when no job exists (a class generated before M7)", async () => {
      const job = t.pipeline!.requestVizTopicsRegeneration(classId);
      expect(job).toMatchObject({ kind: "viz_topics", status: "running", attempt: 1 });
      await waitFor(() => finished(1));
      expect(suggestions()).toHaveLength(2);
      expect(vizJobs()[0]!.parentJobId).not.toBeNull();
    });

    it("reruns as attempt 2 after a failure and passes the existing topics", async () => {
      await failFirstJob();
      const failedId = vizJobs()[0]!.id;
      db()
        .insert(vizSuggestion)
        .values({
          classId,
          concept: "Moja tema",
          section: "",
          misconception: "",
          summary: "Moja tema",
          controlsJson: [],
          scenariosJson: [],
          origin: "user",
        })
        .run();
      const job = t.pipeline!.requestVizTopicsRegeneration(classId);
      expect(job.attempt).toBe(2);
      await waitFor(() => finished(2));
      const second = vizJobs()[1]!;
      expect(second).toMatchObject({ status: "succeeded", parentJobId: failedId });
      expect(identify.mock.calls[1]![0].existing).toEqual([
        { concept: "Moja tema", origin: "user", selected: false },
      ]);
    });

    it("is refused with 409 while running and after success", async () => {
      let release!: () => void;
      identify.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(vizSuggestionsFixture());
          }),
      );
      startBranch();
      await waitFor(() => vizJobs().length === 1);
      expect(() => t.pipeline!.requestVizTopicsRegeneration(classId)).toThrow(/already being/);
      release();
      await waitFor(() => finished(1));
      expect(() => t.pipeline!.requestVizTopicsRegeneration(classId)).toThrow(/already identified/);
    });

    it("is refused with 404 for a missing class and 409 for a class that is not ready", () => {
      expect(() => t.pipeline!.requestVizTopicsRegeneration(9999)).toThrow(/not found/);
      db().update(classTable).set({ status: "failed" }).where(eq(classTable.id, classId)).run();
      expect(() => t.pipeline!.requestVizTopicsRegeneration(classId)).toThrow(/no finished lesson/);
    });
  });
});
