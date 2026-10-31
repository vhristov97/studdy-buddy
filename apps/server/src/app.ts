import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { REPO_ROOT } from "./paths.js";
import { courseRoutes } from "./routes/courses.js";
import { registerErrorHandler } from "./routes/errors.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  config: Config;
  db: Db;
  /** Directory with the built web app. Defaults to apps/web/dist; served only if it has an index.html. */
  webDistDir?: string;
}

export const DEFAULT_WEB_DIST_DIR = path.join(REPO_ROOT, "apps", "web", "dist");

export function buildApp({
  config,
  db,
  webDistDir = DEFAULT_WEB_DIST_DIR,
}: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: process.env.VITEST ? false : true,
  });
  app.decorate("config", config);
  registerErrorHandler(app);
  app.register(healthRoutes, { db });
  app.register(courseRoutes, { db });

  const webRoot = path.resolve(webDistDir);
  if (fs.existsSync(path.join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split("?")[0] ?? "";
      const isApi = pathname === "/api" || pathname.startsWith("/api/");
      // Only navigation requests (no file extension in the last segment) get the SPA shell;
      // missing assets such as /assets/index-oldhash.js must stay 404s.
      const isNavigation = !path.extname(pathname);
      if ((request.method === "GET" || request.method === "HEAD") && !isApi && isNavigation) {
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    });
  }

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
