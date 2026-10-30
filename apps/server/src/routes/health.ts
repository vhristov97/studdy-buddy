import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

export interface HealthRouteOptions {
  db: Db;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, { db }) => {
  app.get("/api/health", async (_request, reply) => {
    try {
      db.get(sql`select 1`);
      return { status: "ok", db: "ok" };
    } catch (err) {
      app.log.error({ err }, "health check: database error");
      return reply.code(503).send({ status: "error", db: "error" });
    }
  });
};
