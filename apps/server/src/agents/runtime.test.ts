import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectTelemetry, warnIfTelemetryOn } from "./runtime.js";

describe("detectTelemetry", () => {
  let dir: string;
  let noCredentials: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-telemetry-test-"));
    noCredentials = os.devNull;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])("detects %s in env", (key) => {
    const env: NodeJS.ProcessEnv = {
      [key]: "secret-value",
      MOZAIK_CREDENTIALS_FILE: noCredentials,
    };
    const found = detectTelemetry({ env, cwd: dir, repoRoot: dir });
    expect(found).toEqual([`${key} (environment)`]);
    expect(found.join()).not.toContain("secret-value");
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])("detects %s in <cwd>/.env", (key) => {
    fs.writeFileSync(path.join(dir, ".env"), `OTHER=1\n${key}="abc"\n`);
    const env: NodeJS.ProcessEnv = { MOZAIK_CREDENTIALS_FILE: noCredentials };
    expect(detectTelemetry({ env, cwd: dir, repoRoot: dir })).toEqual([
      `${key} (${path.join(dir, ".env")})`,
    ]);
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])(
    "detects %s set only in <repoRoot>/.env",
    (key) => {
      const repoRoot = path.join(dir, "root");
      const cwd = path.join(dir, "elsewhere");
      fs.mkdirSync(repoRoot);
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(repoRoot, ".env"), `${key}=abc\n`);
      const env: NodeJS.ProcessEnv = { MOZAIK_CREDENTIALS_FILE: noCredentials };
      expect(detectTelemetry({ env, cwd, repoRoot })).toEqual([
        `${key} (${path.join(repoRoot, ".env")})`,
      ]);
    },
  );

  it("ignores empty and whitespace values in env and in .env", () => {
    fs.writeFileSync(path.join(dir, ".env"), "MOZAIK_API_KEY=\nMOZAIK_PROJECT_KEY=\n");
    const env: NodeJS.ProcessEnv = {
      MOZAIK_API_KEY: "",
      MOZAIK_PROJECT_KEY: "  ",
      MOZAIK_CREDENTIALS_FILE: noCredentials,
    };
    expect(detectTelemetry({ env, cwd: dir, repoRoot: dir })).toEqual([]);
  });

  it("reports nothing without keys, .env or credentials, and leaves env untouched", () => {
    const missing = path.join(dir, "nope.json");
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "x", MOZAIK_CREDENTIALS_FILE: missing };
    expect(detectTelemetry({ env, cwd: dir, repoRoot: dir })).toEqual([]);
    expect(env.MOZAIK_CREDENTIALS_FILE).toBe(missing);
  });

  it("detects paired credentials in the credentials file", () => {
    const file = path.join(dir, "credentials.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ "https://app.jigjoy.ai": { projectKey: "pk", pairedAt: "now" } }),
    );
    const env: NodeJS.ProcessEnv = { MOZAIK_CREDENTIALS_FILE: file };
    const found = detectTelemetry({ env, cwd: dir, repoRoot: dir });
    expect(found).toEqual([`paired credentials (${file})`]);
  });

  it("ignores unusable credentials files", () => {
    const file = path.join(dir, "credentials.json");
    for (const content of ["", "not json", "{}", "[]", '{"https://x":{"other":1}}']) {
      fs.writeFileSync(file, content);
      const env: NodeJS.ProcessEnv = { MOZAIK_CREDENTIALS_FILE: file };
      expect(detectTelemetry({ env, cwd: dir, repoRoot: dir })).toEqual([]);
    }
  });
});

describe("warnIfTelemetryOn", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-telemetry-warn-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns once with the sources when a key is configured", () => {
    const warn = vi.fn();
    const env: NodeJS.ProcessEnv = {
      MOZAIK_API_KEY: "secret-value",
      MOZAIK_CREDENTIALS_FILE: os.devNull,
    };
    warnIfTelemetryOn({ warn }, { env, cwd: dir, repoRoot: dir });
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = warn.mock.calls[0] as [{ sources: string[] }, string];
    expect(obj).toEqual({ sources: ["MOZAIK_API_KEY (environment)"] });
    expect(msg).toContain("Mozaik cloud telemetry is on");
    expect(JSON.stringify(obj)).not.toContain("secret-value");
  });

  it("does not warn when nothing is configured", () => {
    const warn = vi.fn();
    const env: NodeJS.ProcessEnv = { MOZAIK_CREDENTIALS_FILE: os.devNull };
    warnIfTelemetryOn({ warn }, { env, cwd: dir, repoRoot: dir });
    expect(warn).not.toHaveBeenCalled();
  });
});
