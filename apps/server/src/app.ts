import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { REPO_ROOT } from "./paths.js";
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
  app.register(healthRoutes, { db });

  const webRoot = path.resolve(webDistDir);
  if (fs.existsSync(path.join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      const isApi =
        request.url === "/api" ||
        request.url.startsWith("/api/") ||
        request.url.startsWith("/api?");
      if (request.method === "GET" && !isApi) {
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
