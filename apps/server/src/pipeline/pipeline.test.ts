import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { eq } from "drizzle-orm";
import type { LessonDraft, PipelineEvent } from "@studdy/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonWriterInput, LessonWriterOptions } from "../agents/lesson-writer.js";
import { initAgentRuntime } from "../agents/runtime.js";
import { FakeRunner } from "../agents/testing/fake-runner.js";
import { classTable, course, generationJob, material } from "../db/schema.js";
import { ConflictError } from "../repositories/conflict.js";
import { getLessonView } from "../repositories/lessons.js";
import { createTestApp, type TestApp } from "../test/app.js";
import { DOMAIN_EVENTS, type LessonReadyPayload } from "./events.js";
import { RESTART_ERROR, type Pipeline } from "./pipeline.js";

const DRAFT: LessonDraft = {
  lessonMd: "Uvod.\n\n## Replikacija\n\n- Master-slave",
  topics: [
    {
      name: "Replikacija",
      misconceptions: [
        { claim: "Replikacija je isto što i backup", correction: "Nije isto." },
        { claim: "Slave piše", correction: "Slave samo čita." },
      ],
      deferred: false,
      deferredNote: null,
    },
    { name: "Sharding", misconceptions: [], deferred: true, deferredNote: "Na sledećem času." },
  ],
};

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type FakeWriter = (input: LessonWriterInput, opts?: LessonWriterOptions) => Promise<LessonDraft>;

let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-pipeline-test-"));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new FakeRunner(() => new Error("not used")),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("pipeline", () => {
  let t: TestApp;
  let pipeline: Pipeline;
  let writer: ReturnType<typeof vi.fn<FakeWriter>>;
  let events: SemanticEvent[];
  let classId: number;
  let courseId: number;

  const jobs = () => t.handle.db.select().from(generationJob).all();
  const classStatus = () =>
    t.handle.db.select().from(classTable).where(eq(classTable.id, classId)).get()!.status;
  const types = () => events.map((e) => e.type);

  function addMaterial(kind: "material" | "note", name: string, text: string | null, ok = true) {
    t.handle.db
      .insert(material)
      .values({
        classId,
        kind,
        originalName: name,
        mime: kind === "note" ? "text/markdown" : "application/pdf",
        sizeBytes: 10,
        sha256: `${name}-hash`,
        storagePath: `files/xx/${name}`,
        extractedText: text,
        extractionStatus: ok ? "ok" : "failed",
        extractionError: ok ? null : "bad",
        pageCount: null,
      })
      .run();
  }

  beforeEach(() => {
    writer = vi.fn<FakeWriter>(async () => DRAFT);
    t = createTestApp({
      pipeline: { writeLesson: writer, progressIntervalMs: 500, quizAutoStart: false },
    });
    pipeline = t.pipeline!;
    events = [];
    t.coordinator!.subscribe((e) => events.push(e));
    courseId = t.handle.db
      .insert(course)
      .values({ name: "Kurs", persona: "mentor", assessmentFormat: null })
      .returning({ id: course.id })
      .get().id;
    classId = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 1, title: "Uvod" })
      .returning({ id: classTable.id })
      .get().id;
    addMaterial("material", "b.pdf", "TEKST B");
    addMaterial("material", "a.pdf", "TEKST A");
    addMaterial("note", "n.md", "BELESKA");
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("persists the lesson, topics and notes events, then emits lesson.ready", async () => {
    const job = pipeline.requestGeneration(classId);
    expect(job).toMatchObject({ status: "running", attempt: 1, kind: "lesson", error: null });
    expect(classStatus()).toBe("generating");

    await waitFor(() => types().includes(DOMAIN_EVENTS.LESSON_READY));

    expect(types()).toEqual([
      DOMAIN_EVENTS.JOB_UPDATED,
      DOMAIN_EVENTS.GENERATE_REQUESTED,
      DOMAIN_EVENTS.JOB_UPDATED,
      DOMAIN_EVENTS.LESSON_READY,
    ]);
    const [running, , succeeded] = events.map((e) => e.payload as PipelineEvent);
    expect(running).toMatchObject({ type: "job", classStatus: "generating" });
    expect(succeeded).toMatchObject({
      type: "job",
      classStatus: "ready",
      job: { id: job.id, status: "succeeded" },
    });
    expect((succeeded as { job: { finishedAt: string | null } }).job.finishedAt).not.toBeNull();

    const view = getLessonView(t.handle.db, classId)!;
    expect(events[3]!.payload as LessonReadyPayload).toEqual({
      classId,
      lessonId: expect.any(Number),
    });
    expect(view.bodyMd).toBe(DRAFT.lessonMd);
    expect(
      view.topics.map((x) => [x.name, x.position, x.rating, x.deferred, x.deferredNote]),
    ).toEqual([
      ["Replikacija", 0, "?", false, null],
      ["Sharding", 1, "?", true, "Na sledećem času."],
    ]);
    expect(
      view.topics[0]!.events.map((e) => [
        e.source,
        e.outcome,
        e.misconceptionText,
        e.correctionText,
      ]),
    ).toEqual([
      ["notes", "misconception", "Replikacija je isto što i backup", "Nije isto."],
      ["notes", "misconception", "Slave piše", "Slave samo čita."],
    ]);
    expect(view.topics[1]!.events).toEqual([]);
    expect(classStatus()).toBe("ready");
  });

  it("gives the writer the course, class, usable materials and notes", async () => {
    pipeline.requestGeneration(classId);
    await waitFor(() => writer.mock.calls.length === 1);
    expect(writer.mock.calls[0]![0]).toEqual({
      course: { name: "Kurs", persona: "mentor", assessmentFormat: null },
      class: { number: 1, title: "Uvod" },
      materials: [
        { name: "a.pdf", text: "TEKST A" },
        { name: "b.pdf", text: "TEKST B" },
      ],
      notes: [{ name: "n.md", text: "BELESKA" }],
    });
  });

  it("fails the job and the class when the writer throws, then retries as attempt 2", async () => {
    writer.mockRejectedValueOnce(new Error("boom"));
    const first = pipeline.requestGeneration(classId);
    await waitFor(() => classStatus() === "failed");

    const [failed] = jobs();
    expect(failed).toMatchObject({ id: first.id, status: "failed", error: "boom" });
    expect(failed!.finishedAt).not.toBeNull();
    expect(types()).not.toContain(DOMAIN_EVENTS.LESSON_READY);
    expect(events.at(-1)!.payload).toMatchObject({
      type: "job",
      classStatus: "failed",
      job: { status: "failed", error: "boom" },
    });
    expect(getLessonView(t.handle.db, classId)).toBeUndefined();

    const second = pipeline.requestGeneration(classId);
    expect(second.attempt).toBe(2);
    expect(jobs().find((j) => j.id === second.id)!.parentJobId).toBe(first.id);
    await waitFor(() => classStatus() === "ready");
    expect(first.attempt).toBe(1);
    expect(jobs().find((j) => j.id === first.id)!.parentJobId).toBeNull();
  });

  it("includes the stage error kind in the job error", async () => {
    const { StageError } = await import("../agents/stage.js");
    writer.mockRejectedValueOnce(new StageError("schema", "answer does not match"));
    pipeline.requestGeneration(classId);
    await waitFor(() => classStatus() === "failed");
    expect(jobs()[0]!.error).toBe("Lesson writer failed (schema): answer does not match");
  });

  it("fails the job and leaves no partial rows when persisting fails", async () => {
    const dup = { ...DRAFT.topics[0]!, misconceptions: [] };
    writer.mockResolvedValueOnce({ ...DRAFT, topics: [dup, { ...dup }] });
    pipeline.requestGeneration(classId);
    await waitFor(() => classStatus() === "failed");
    expect(jobs()[0]!.status).toBe("failed");
    expect(getLessonView(t.handle.db, classId)).toBeUndefined();
    expect(types()).not.toContain(DOMAIN_EVENTS.LESSON_READY);
  });

  it("refuses to start twice, after success, without usable materials, and for unknown classes", async () => {
    let release!: (draft: LessonDraft) => void;
    writer.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    pipeline.requestGeneration(classId);
    expect(() => pipeline.requestGeneration(classId)).toThrow(/already generating/);
    release(DRAFT);
    await waitFor(() => classStatus() === "ready");
    expect(() => pipeline.requestGeneration(classId)).toThrow(/already generated/);
    expect(jobs()).toHaveLength(1);

    const emptyClass = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 2, title: "Prazan" })
      .returning({ id: classTable.id })
      .get().id;
    expect(() => pipeline.requestGeneration(emptyClass)).toThrow(/no class materials/);
    expect(
      t.handle.db.select().from(classTable).where(eq(classTable.id, emptyClass)).get()!.status,
    ).toBe("draft");

    expect(() => pipeline.requestGeneration(9999)).toThrow(/Class not found/);
  });

  it("does not count notes or failed extractions as usable materials", () => {
    t.handle.db.delete(material).run();
    addMaterial("note", "n.md", "BELESKA");
    expect(() => pipeline.requestGeneration(classId)).toThrow(/no class materials/);
  });

  it.each(["material", "note"] as const)(
    "refuses to generate while a %s with failed extraction exists",
    (kind) => {
      addMaterial(kind, "broken.pdf", null, false);
      addMaterial(kind, "also-broken.pdf", null, false);
      expect(() => pipeline.requestGeneration(classId)).toThrow(ConflictError);
      expect(() => pipeline.requestGeneration(classId)).toThrow(
        /could not be extracted.*also-broken\.pdf, broken\.pdf/,
      );
      expect(classStatus()).toBe("draft");
      expect(jobs()).toHaveLength(0);
      expect(writer).not.toHaveBeenCalled();
    },
  );

  it("emits throttled progress events counting streamed characters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const delta = (text: string) =>
        ({
          type: "inference.stream",
          payload: { type: "content_block_delta", delta: { type: "text_delta", text } },
        }) as unknown as SemanticEvent;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      writer.mockImplementationOnce(async (_input, opts) => {
        opts?.onEvent?.(delta("abc"));
        opts?.onEvent?.(delta("de")); // within 500 ms: counted, not emitted
        opts?.onEvent?.({
          type: "inference.stream",
          payload: { type: "message_start" },
        } as unknown as SemanticEvent);
        vi.setSystemTime(Date.now() + 600);
        opts?.onEvent?.(delta("fgh"));
        await gate;
        return DRAFT;
      });
      const job = t.pipeline!.requestGeneration(classId);
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === DOMAIN_EVENTS.JOB_PROGRESS)).toHaveLength(2),
      );
      expect(
        events.filter((e) => e.type === DOMAIN_EVENTS.JOB_PROGRESS).map((e) => e.payload),
      ).toEqual([
        { type: "progress", classId, jobId: job.id, stage: "lesson-writer", outputChars: 3 },
        { type: "progress", classId, jobId: job.id, stage: "lesson-writer", outputChars: 8 },
      ]);
      release();
      await waitFor(() => classStatus() === "ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recoverInterruptedJobs fails running jobs and generating classes", () => {
    const db = t.handle.db;
    const stuck = db
      .insert(generationJob)
      .values({ classId, kind: "lesson", stage: "lesson-writer", status: "running", attempt: 1 })
      .returning({ id: generationJob.id })
      .get().id;
    db.update(classTable).set({ status: "generating" }).where(eq(classTable.id, classId)).run();

    pipeline.recoverInterruptedJobs();

    const job = jobs().find((j) => j.id === stuck)!;
    expect(job).toMatchObject({ status: "failed", error: RESTART_ERROR });
    expect(job.finishedAt).not.toBeNull();
    expect(classStatus()).toBe("failed");
    // and the class can be generated again
    expect(pipeline.requestGeneration(classId)).toMatchObject({ attempt: 2 });
  });
});
