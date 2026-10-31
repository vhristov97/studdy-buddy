import type { FastifyPluginAsync } from "fastify";
import type { ClassJobs, PipelineEvent } from "@studdy/shared";
import type { Coordinator } from "../agents/coordinator.js";
import type { Db } from "../db/client.js";
import { getClassStatus, getLessonView, listJobs } from "../repositories/lessons.js";
import { DOMAIN_EVENTS } from "../pipeline/events.js";
import type { Pipeline } from "../pipeline/pipeline.js";
import { notFound, parseId } from "./errors.js";

export interface GenerationRouteOptions {
  db: Db;
  /** Without them only the read routes exist. */
  pipeline?: Pipeline;
  coordinator?: Coordinator;
  heartbeatMs?: number;
}

interface ClassParams {
  classId: string;
}

export const generationRoutes: FastifyPluginAsync<GenerationRouteOptions> = async (
  app,
  { db, pipeline, coordinator, heartbeatMs = 15_000 },
) => {
  function requireClass(rawId: string): number {
    const classId = parseId("classId", rawId);
    if (getClassStatus(db, classId) === undefined) throw notFound("Class");
    return classId;
  }

  app.get<{ Params: ClassParams }>("/api/classes/:classId/lesson", async (request) => {
    const lesson = getLessonView(db, requireClass(request.params.classId));
    if (!lesson) throw notFound("Lesson");
    return lesson;
  });

  app.get<{ Params: ClassParams }>(
    "/api/classes/:classId/jobs",
    async (request): Promise<ClassJobs> => ({
      jobs: listJobs(db, requireClass(request.params.classId)),
    }),
  );

  if (!pipeline || !coordinator) return;

  app.post<{ Params: ClassParams }>("/api/classes/:classId/generate", async (request, reply) => {
    const classId = parseId("classId", request.params.classId);
    return reply.code(202).send(pipeline.requestGeneration(classId));
  });

  app.post<{ Params: ClassParams }>(
    "/api/classes/:classId/quiz/regenerate",
    async (request, reply) => {
      const classId = parseId("classId", request.params.classId);
      return reply.code(202).send(pipeline.requestQuizRegeneration(classId));
    },
  );

  app.post<{ Params: { submissionId: string } }>(
    "/api/submissions/:submissionId/grade",
    async (request, reply) => {
      const submissionId = parseId("submissionId", request.params.submissionId);
      return reply.code(202).send(pipeline.requestGrading(submissionId));
    },
  );

  const openStreams = new Set<() => void>();
  // Without this, `app.close()` would wait forever for the open event streams. It has to be
  // `preClose`: `onClose` hooks only run after the server has closed, i.e. after the streams end.
  app.addHook("preClose", async () => {
    for (const close of [...openStreams]) close();
  });

  app.get<{ Params: ClassParams }>("/api/classes/:classId/events", async (request, reply) => {
    const classId = requireClass(request.params.classId);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: PipelineEvent): void => {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Catch-up for a (re)connecting client. Everything up to `subscribe` is synchronous, so no
    // event can fall between the snapshot and the live feed.
    const classStatus = getClassStatus(db, classId);
    if (classStatus) {
      for (const job of listJobs(db, classId).reverse()) send({ type: "job", job, classStatus });
    }
    raw.write(": connected\n\n");

    const unsubscribe = coordinator.subscribe((event) => {
      if (event.type !== DOMAIN_EVENTS.JOB_UPDATED && event.type !== DOMAIN_EVENTS.JOB_PROGRESS) {
        return;
      }
      const payload = event.payload as PipelineEvent;
      const eventClassId = payload.type === "job" ? payload.job.classId : payload.classId;
      if (eventClassId === classId) send(payload);
    });
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(": ping\n\n");
    }, heartbeatMs);
    heartbeat.unref();

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(close);
      if (!raw.writableEnded) raw.end();
    };
    openStreams.add(close);
    raw.on("close", close);
  });
};
