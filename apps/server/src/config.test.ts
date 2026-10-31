import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { REPO_ROOT } from "./paths.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.HOST).toBe("127.0.0.1");
    expect(c.DATA_DIR).toBe(path.join(REPO_ROOT, "data"));
    expect(c.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(c.MODEL_PLANNER).toBe("claude-opus-5-5");
    expect(c.MODEL_BUILDER).toBe("claude-sonnet-5-5");
  });

  it("coerces PORT to a number", () => {
    expect(loadConfig({ PORT: "4321" }).PORT).toBe(4321);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow();
  });

  it("resolves a relative DATA_DIR against the repo root", () => {
    expect(loadConfig({ DATA_DIR: "./somewhere/else" }).DATA_DIR).toBe(
      path.join(REPO_ROOT, "somewhere", "else"),
    );
  });

  it("keeps an absolute DATA_DIR", () => {
    expect(loadConfig({ DATA_DIR: "/tmp/x" }).DATA_DIR).toBe("/tmp/x");
  });

  it("treats an empty ANTHROPIC_BASE_URL as unset", () => {
    expect(loadConfig({ ANTHROPIC_BASE_URL: "" }).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("keeps a valid ANTHROPIC_BASE_URL", () => {
    const url = "https://api.app.jigjoy.ai/gateway/anthropic";
    expect(loadConfig({ ANTHROPIC_BASE_URL: url }).ANTHROPIC_BASE_URL).toBe(url);
  });

  it("rejects an invalid ANTHROPIC_BASE_URL", () => {
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: "not a url" })).toThrow();
  });

  it("rejects an ANTHROPIC_BASE_URL with a query", () => {
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: "https://gw.example.com/a?x=y" })).toThrow();
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: "https://gw.example.com/a?" })).toThrow();
  });

  it("rejects an ANTHROPIC_BASE_URL with a fragment", () => {
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: "https://gw.example.com/a#x" })).toThrow();
  });

  it("rejects an http ANTHROPIC_BASE_URL on a remote host", () => {
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: "http://gw.example.com/anthropic" })).toThrow();
  });

  it("accepts an http ANTHROPIC_BASE_URL on a loopback host", () => {
    for (const url of [
      "http://localhost:8080",
      "http://127.0.0.1:4000/anthropic",
      "http://[::1]:4000",
    ]) {
      expect(loadConfig({ ANTHROPIC_BASE_URL: url }).ANTHROPIC_BASE_URL).toBe(url);
    }
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });
});
