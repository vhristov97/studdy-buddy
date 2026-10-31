import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  ApiErrorBody,
  ClassJobs,
  GenerationJob,
  LessonView,
  PipelineEvent,
  type LessonDraft,
} from "@studdy/shared";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ResilientRunner } from "../agents/resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "../agents/runtime.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponder } from "../agents/testing/fake-runner.js";
import { classTable, course, material } from "../db/schema.js";
import { registerErrorHandler } from "./errors.js";
import { generationRoutes } from "./generation.js";
import { createTestApp, type TestApp } from "../test/app.js";

const DRAFT: LessonDraft = {
  lessonMd: "Uvod u replikaciju.\n\n## Replikacija\n\n- Master-slave\n- Multi-master",
  topics: [
    { name: "Replikacija", misconceptions: [], deferred: false, deferredNote: null },
    { name: "Sharding", misconceptions: [], deferred: true, deferredNote: "Na sledećem času." },
  ],
};

let responder: FakeResponder;
let tmpCwd: string;
beforeAll(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-generation-test-"));
  const inner = new FakeRunner((input, i) => responder(input, i));
  initAgentRuntime({
    cwd: tmpCwd,
    repoRoot: tmpCwd,
    runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
  });
});
afterAll(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("generation routes (real lesson writer, fake model)", () => {
  let t: TestApp;
  let classId: number;

  function seed(withMaterial: boolean): void {
    const courseId = t.handle.db
      .insert(course)
      .values({ name: "Kurs" })
      .returning({ id: course.id })
      .get().id;
    classId = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 1, title: "Uvod" })
      .returning({ id: classTable.id })
      .get().id;
    if (withMaterial) {
      t.handle.db
        .insert(material)
        .values({
          classId,
          kind: "material",
          originalName: "slajdovi.pdf",
          mime: "application/pdf",
          sizeBytes: 10,
          sha256: "h",
          storagePath: "files/h/h.pdf",
          extractedText: "--- strana 1 ---\n## Replikacija\n- Master-slave",
          extractionStatus: "ok",
        })
        .run();
    }
  }

  beforeEach(() => {
    t = createTestApp({ pipeline: {} });
  });
  afterEach(async () => {
    await t.cleanup();
  });

  const get = async (url: string) => {
    const res = await t.app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() as unknown };
  };

  it("generates a lesson through the model and serves it", async () => {
    responder = () => fakeJsonAnswer(DRAFT);
    seed(true);

    const res = await t.app.inject({ method: "POST", url: `/api/classes/${classId}/generate` });
    expect(res.statusCode).toBe(202);
    const job = GenerationJob.parse(res.json());
    expect(job).toMatchObject({ classId, status: "running", attempt: 1, stage: "lesson-writer" });

    await waitFor(async () => {
      const jobs = ClassJobs.parse((await get(`/api/classes/${classId}/jobs`)).body);
      return jobs.jobs[0]?.status === "succeeded";
    });

    const lesson = LessonView.parse((await get(`/api/classes/${classId}/lesson`)).body);
    expect(lesson.bodyMd).toBe(DRAFT.lessonMd);
    expect(lesson.topics.map((x) => x.name)).toEqual(["Replikacija", "Sharding"]);
    const detail = (await get(`/api/classes/${classId}`)).body as { status: string };
    expect(detail.status).toBe("ready");

    const again = await t.app.inject({ method: "POST", url: `/api/classes/${classId}/generate` });
    expect(again.statusCode).toBe(409);
    expect(ApiErrorBody.parse(again.json()).error.code).toBe("conflict");
  });

  it("records a model failure on the job and the class", async () => {
    responder = () => Object.assign(new Error("bad request"), { status: 400 });
    seed(true);
    await t.app.inject({ method: "POST", url: `/api/classes/${classId}/generate` });
    await waitFor(async () => {
      const jobs = ClassJobs.parse((await get(`/api/classes/${classId}/jobs`)).body);
      return jobs.jobs[0]?.status === "failed";
    });
    const jobs = ClassJobs.parse((await get(`/api/classes/${classId}/jobs`)).body);
    expect(jobs.jobs[0]!.error).toMatch(/^Lesson writer failed \(failed\)/);
    expect(((await get(`/api/classes/${classId}`)).body as { status: string }).status).toBe(
      "failed",
    );
    expect((await get(`/api/classes/${classId}/lesson`)).status).toBe(404);
  });

  it("answers 404, 409 and 400 with an ApiErrorBody", async () => {
    seed(false);
    const post = (id: string | number) =>
      t.app.inject({ method: "POST", url: `/api/classes/${id}/generate` });

    const noMaterials = await post(classId);
    expect(noMaterials.statusCode).toBe(409);
    expect(ApiErrorBody.parse(noMaterials.json()).error.message).toMatch(/no class materials/);

    const missing = await post(9999);
    expect(missing.statusCode).toBe(404);
    expect(ApiErrorBody.parse(missing.json()).error.code).toBe("not_found");
    expect((await post("abc")).statusCode).toBe(400);

    for (const suffix of ["lesson", "jobs", "events"]) {
      expect((await get(`/api/classes/9999/${suffix}`)).status).toBe(404);
    }
    expect((await get(`/api/classes/${classId}/lesson`)).status).toBe(404);
    expect((await get(`/api/classes/${classId}/jobs`)).body).toEqual({ jobs: [] });
  });
});

describe("event stream", () => {
  let t: TestApp;
  let release: (draft: LessonDraft) => void;
  let classId: number;
  let baseUrl: string;

  beforeEach(async () => {
    t = createTestApp({
      pipeline: { writeLesson: () => new Promise<LessonDraft>((resolve) => (release = resolve)) },
    });
    const courseId = t.handle.db
      .insert(course)
      .values({ name: "Kurs" })
      .returning({ id: course.id })
      .get().id;
    classId = t.handle.db
      .insert(classTable)
      .values({ courseId, number: 1, title: "Uvod" })
      .returning({ id: classTable.id })
      .get().id;
    t.handle.db
      .insert(material)
      .values({
        classId,
        kind: "material",
        originalName: "s.pdf",
        mime: "application/pdf",
        sizeBytes: 1,
        sha256: "h",
        storagePath: "files/h/h.pdf",
        extractedText: "tekst",
        extractionStatus: "ok",
      })
      .run();
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  /** Collects parsed SSE events from a response until aborted. */
  function collect(res: Response) {
    const seen: Array<{ name: string; event: PipelineEvent }> = [];
    const comments: string[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    const done = (async () => {
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (block.startsWith(":")) {
              comments.push(block);
              continue;
            }
            const name = /^event: (.*)$/m.exec(block)![1]!;
            const data = /^data: (.*)$/m.exec(block)![1]!;
            seen.push({ name, event: PipelineEvent.parse(JSON.parse(data)) });
          }
        }
      } catch {
        // aborted
      }
    })();
    return { seen, comments, done };
  }

  it("catches a client up, streams job updates and unsubscribes on disconnect", async () => {
    const first = t.pipeline!.requestGeneration(classId);

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/classes/${classId}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const stream = collect(res);

    await waitFor(() => stream.seen.length === 1);
    expect(stream.seen[0]).toMatchObject({
      name: "job",
      event: { type: "job", classStatus: "generating", job: { id: first.id, status: "running" } },
    });

    release(DRAFT);
    await waitFor(() => stream.seen.length === 2);
    expect(stream.seen[1]).toMatchObject({
      name: "job",
      event: { type: "job", classStatus: "ready", job: { id: first.id, status: "succeeded" } },
    });

    controller.abort();
    await stream.done;
    await waitFor(() => listenerCount(t) === 0);
  });

  it("only forwards events of its own class", async () => {
    const otherClass = t.handle.db
      .insert(classTable)
      .values({ courseId: 1, number: 2, title: "Drugi" })
      .returning({ id: classTable.id })
      .get().id;
    const res = await fetch(`${baseUrl}/api/classes/${otherClass}/events`);
    const stream = collect(res);
    await waitFor(() => stream.comments.includes(": connected"));
    t.pipeline!.requestGeneration(classId);
    await new Promise((r) => setTimeout(r, 50));
    expect(stream.seen).toEqual([]);
  });

  it("sends heartbeat comments", async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.register(generationRoutes, {
      db: t.handle.db,
      pipeline: t.pipeline!,
      coordinator: t.coordinator!,
      heartbeatMs: 20,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const stream = collect(await fetch(`${url}/api/classes/${classId}/events`));
      await waitFor(() => stream.comments.includes(": ping"));
    } finally {
      await app.close();
    }
  });

  it("ends open streams when the app closes", async () => {
    const res = await fetch(`${baseUrl}/api/classes/${classId}/events`);
    const stream = collect(res);
    await waitFor(() => stream.comments.includes(": connected"));
    await t.app.close();
    await stream.done;
    expect(listenerCount(t)).toBe(0);
  });
});

/** Subscribers of the coordinator; reads the private set since only the tests need the number. */
function listenerCount(t: TestApp): number {
  return (t.coordinator as unknown as { listeners: Set<unknown> }).listeners.size;
}
