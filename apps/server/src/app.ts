import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Coordinator } from "./agents/coordinator.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { REPO_ROOT } from "./paths.js";
import { courseRoutes } from "./routes/courses.js";
import { errorBody, registerErrorHandler } from "./routes/errors.js";
import { generationRoutes } from "./routes/generation.js";
import { healthRoutes } from "./routes/health.js";
import { materialRoutes } from "./routes/materials.js";
import { progressRoutes } from "./routes/progress.js";
import { quizRoutes } from "./routes/quizzes.js";
import { submissionRoutes } from "./routes/submissions.js";
import type { Pipeline } from "./pipeline/pipeline.js";

export interface AppDeps {
  config: Config;
  db: Db;
  /** Directory with the built web app. Defaults to apps/web/dist; served only if it has an index.html. */
  webDistDir?: string;
  /** Without the pipeline and coordinator, generating and the event stream are not available. */
  pipeline?: Pipeline;
  coordinator?: Coordinator;
}

export const DEFAULT_WEB_DIST_DIR = path.join(REPO_ROOT, "apps", "web", "dist");

export function buildApp({
  config,
  db,
  webDistDir = DEFAULT_WEB_DIST_DIR,
  pipeline,
  coordinator,
}: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: process.env.VITEST ? false : true,
  });
  app.decorate("config", config);
  registerErrorHandler(app);
  app.register(healthRoutes, { db });
  app.register(courseRoutes, { db, dataDir: config.DATA_DIR });
  app.register(materialRoutes, { db, dataDir: config.DATA_DIR });
  app.register(quizRoutes, { db });
  app.register(progressRoutes, { db });
  app.register(submissionRoutes, { db, ...(coordinator && { coordinator }) });
  app.register(generationRoutes, {
    db,
    ...(pipeline && { pipeline }),
    ...(coordinator && { coordinator }),
  });

  const webRoot = path.resolve(webDistDir);
  const hasWebDist = fs.existsSync(path.join(webRoot, "index.html"));
  if (hasWebDist) app.register(fastifyStatic, { root: webRoot });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0] ?? "";
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    if (isApi) {
      return reply
        .code(404)
        .send(errorBody("not_found", `Route ${request.method}:${request.url} not found`));
    }
    // Only navigation requests (no file extension in the last segment) get the SPA shell;
    // missing assets such as /assets/index-oldhash.js must stay 404s.
    const isNavigation = !path.extname(pathname);
    if (hasWebDist && (request.method === "GET" || request.method === "HEAD") && isNavigation) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    return reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
