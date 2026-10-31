import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test/app.js";

describe("GET /api/health", () => {
  let t: TestApp;

  beforeEach(() => {
    t = createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("returns ok when the database works", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });

  it("has the app_meta table after migrations", () => {
    const row = t.handle.db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'app_meta'")
      .get();
    expect(row).toEqual({ name: "app_meta" });
    expect(fs.existsSync(path.join(t.dir, "app.sqlite"))).toBe(true);
  });

  it("returns 503 when the database is unavailable", async () => {
    t.handle.close();
    const res = await t.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "error", db: "error" });
  });
});
