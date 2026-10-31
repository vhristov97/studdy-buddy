import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDevProxy, resolveApiPort } from "./devProxy";

describe("resolveApiPort", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-devproxy-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses PORT from the .env file when the process env has none", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=4321\n");
    expect(resolveApiPort(dir, {})).toBe("4321");
  });

  it("prefers the process env PORT over the .env file", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=4321\n");
    expect(resolveApiPort(dir, { PORT: "5555" })).toBe("5555");
  });

  it("defaults to 3000 when neither is set", () => {
    expect(resolveApiPort(dir, {})).toBe("3000");
    fs.writeFileSync(path.join(dir, ".env"), "OTHER=1\n");
    expect(resolveApiPort(dir, {})).toBe("3000");
  });

  it("ignores .env.[mode] and .env.local files", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=4321\n");
    fs.writeFileSync(path.join(dir, ".env.development"), "PORT=7777\n");
    fs.writeFileSync(path.join(dir, ".env.local"), "PORT=8888\n");
    expect(resolveApiPort(dir, {})).toBe("4321");
    fs.rmSync(path.join(dir, ".env"));
    expect(resolveApiPort(dir, {})).toBe("3000");
  });
});

describe("buildDevProxy", () => {
  // Mirrors Vite's matching: keys starting with "^" are RegExps, others are URL prefixes.
  const matches = (key: string, url: string) =>
    key.startsWith("^") ? new RegExp(key).test(url) : url.startsWith(key);
  const proxied = (url: string) =>
    Object.keys(buildDevProxy("http://127.0.0.1:3000")).some((key) => matches(key, url));

  it("proxies /api and /viz/ paths", () => {
    expect(proxied("/api/courses")).toBe(true);
    expect(proxied("/viz/1")).toBe(true);
    expect(proxied("/viz/1/index.html")).toBe(true);
  });

  it("leaves the SPA route /vizualizacije/:id to Vite", () => {
    expect(proxied("/vizualizacije/1")).toBe(false);
  });
});
