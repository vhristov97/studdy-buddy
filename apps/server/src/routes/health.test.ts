import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";

describe("GET /api/health", () => {
  let dir: string;
  let handle: DatabaseHandle;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-test-"));
    handle = openDatabase(dir);
    migrate(handle.db);
    app = buildApp({ config: loadConfig({ DATA_DIR: dir }), db: handle.db });
  });

  afterEach(async () => {
    await app.close();
    try {
      handle.close();
    } catch {
      // already closed by the test
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns ok when the database works", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("has the app_meta table after migrations", () => {
    const row = handle.db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'app_meta'")
      .get();
    expect(row).toEqual({ name: "app_meta" });
    expect(fs.existsSync(path.join(dir, "app.sqlite"))).toBe(true);
  });

  it("returns 503 when the database is unavailable", async () => {
    handle.close();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "error", db: "error" });
  });
});
