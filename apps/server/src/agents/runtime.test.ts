import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_OPT_IN_KEY, assertTelemetryDisabled } from "./runtime.js";

describe("assertTelemetryDisabled", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-telemetry-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])("throws when %s is set in env", (key) => {
    const env: NodeJS.ProcessEnv = { [key]: "secret-value" };
    expect(() => assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir })).toThrow(key);
    expect(() => assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir })).not.toThrow(
      /secret-value/,
    );
    expect(env.MOZAIK_CREDENTIALS_FILE).toBeUndefined();
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])(
    "throws when %s is set in <cwd>/.env",
    (key) => {
      fs.writeFileSync(path.join(dir, ".env"), `OTHER=1\n${key}="abc"\n`);
      expect(() => assertTelemetryDisabled({ env: {}, cwd: dir, repoRoot: dir })).toThrow(key);
    },
  );

  it("ignores empty values in env and in .env", () => {
    fs.writeFileSync(path.join(dir, ".env"), "MOZAIK_API_KEY=\nMOZAIK_PROJECT_KEY=\n");
    const env: NodeJS.ProcessEnv = { MOZAIK_API_KEY: "", MOZAIK_PROJECT_KEY: "  " };
    expect(() => assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir })).not.toThrow();
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])(
    "throws when %s is set only in <repoRoot>/.env",
    (key) => {
      const repoRoot = path.join(dir, "root");
      const cwd = path.join(dir, "elsewhere");
      fs.mkdirSync(repoRoot);
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(repoRoot, ".env"), `${key}=abc\n`);
      const env: NodeJS.ProcessEnv = {};
      expect(() => assertTelemetryDisabled({ env, cwd, repoRoot })).toThrow(key);
      expect(env.MOZAIK_CREDENTIALS_FILE).toBeUndefined();
    },
  );

  it("opt-in in env allows telemetry keys and leaves credentials lookup alone", () => {
    const env: NodeJS.ProcessEnv = {
      [CLOUD_OPT_IN_KEY]: "true",
      MOZAIK_API_KEY: "key",
      MOZAIK_CREDENTIALS_FILE: path.join(dir, "creds.json"),
    };
    expect(() => assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir })).not.toThrow();
    expect(env.MOZAIK_CREDENTIALS_FILE).toBe(path.join(dir, "creds.json"));
  });

  it("opt-in in <repoRoot>/.env allows telemetry keys", () => {
    fs.writeFileSync(
      path.join(dir, ".env"),
      `${CLOUD_OPT_IN_KEY}=true\nMOZAIK_API_KEY=key\n`,
    );
    const env: NodeJS.ProcessEnv = {};
    expect(() => assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir })).not.toThrow();
    expect(env.MOZAIK_CREDENTIALS_FILE).toBeUndefined();
  });

  it.each(["false", "0", "no", "off"])("opt-in value %q does not opt in", (value) => {
    const env: NodeJS.ProcessEnv = { [CLOUD_OPT_IN_KEY]: value, MOZAIK_API_KEY: "key" };
    expect(() => assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir })).toThrow(
      "MOZAIK_API_KEY",
    );
  });

  it("accepts a missing .env and disables the SDK credentials lookup", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "x" };
    assertTelemetryDisabled({ env, cwd: dir, repoRoot: dir });
    expect(env.MOZAIK_CREDENTIALS_FILE).toBe(os.devNull);
    // Same lookup as the SDK's readAll(): parse the file, treat any failure as "no credentials".
    let credentials: unknown;
    try {
      credentials = JSON.parse(fs.readFileSync(env.MOZAIK_CREDENTIALS_FILE!, "utf8"));
    } catch {
      credentials = {};
    }
    expect(credentials).toEqual({});
  });
});
