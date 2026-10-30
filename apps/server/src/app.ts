import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  config: Config;
  db: Db;
}

export function buildApp({ config, db }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: process.env.VITEST ? false : true,
  });
  app.decorate("config", config);
  app.register(healthRoutes, { db });
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
