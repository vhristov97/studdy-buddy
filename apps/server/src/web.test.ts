import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase, type DatabaseHandle } from "./db/client.js";

const INDEX_HTML = '<!doctype html><html><body><div id="root">spa</div></body></html>';

describe("web app serving", () => {
  let dir: string;
  let handle: DatabaseHandle;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-web-test-"));
    handle = openDatabase(dir);
    migrate(handle.db);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(webDistDir: string): FastifyInstance {
    app = buildApp({ config: loadConfig({ DATA_DIR: dir }), db: handle.db, webDistDir });
    return app;
  }

  describe("with a built dist dir", () => {
    let dist: string;

    beforeEach(() => {
      dist = path.join(dir, "dist");
      fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
      fs.writeFileSync(path.join(dist, "index.html"), INDEX_HTML);
      fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1);");
    });

    it("serves index.html at /", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe(INDEX_HTML);
    });

    it("serves static assets", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/assets/app.js" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("console.log(1);");
    });

    it("falls back to index.html for unknown client routes", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/some/client/route" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe(INDEX_HTML);
    });

    it.each(["/assets/index-oldhash.js", "/favicon.ico", "/missing.css"])(
      "returns 404 (not index.html) for missing file %s",
      async (url) => {
        const res = await build(dist).inject({ method: "GET", url });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toBe(INDEX_HTML);
      },
    );

    it("falls back to index.html for client routes like /kursevi/1", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/kursevi/1" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX_HTML);
    });

    it("returns a JSON 404 for unknown /api routes", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/api/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("still serves the API", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok", db: "ok" });
    });

    it.each(["/viz/999", "/viz/", "/viz/1/extra"])(
      "does not serve the app shell for %s",
      async (url) => {
        const res = await build(dist).inject({ method: "GET", url });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toBe(INDEX_HTML);
        expect(res.json()).toMatchObject({ error: { code: "not_found" } });
      },
    );

    it("falls back to index.html for the client route /vizualizacije/1", async () => {
      const res = await build(dist).inject({ method: "GET", url: "/vizualizacije/1" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX_HTML);
    });

    it("returns 404 for non-GET requests to unknown routes", async () => {
      const res = await build(dist).inject({ method: "POST", url: "/some/route" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("without a dist dir", () => {
    it("returns an ApiErrorBody 404 for unknown /api routes", async () => {
      const res = await build(path.join(dir, "missing")).inject({
        method: "GET",
        url: "/api/nope",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: "not_found" } });
    });

    it("returns 404 for /", async () => {
      const res = await build(path.join(dir, "missing")).inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for client routes", async () => {
      const res = await build(path.join(dir, "missing")).inject({
        method: "GET",
        url: "/kursevi/1",
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
