import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTelemetryDisabled } from "./runtime.js";

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
    expect(() => assertTelemetryDisabled(env, dir)).toThrow(key);
    expect(() => assertTelemetryDisabled(env, dir)).not.toThrow(/secret-value/);
    expect(env.MOZAIK_CREDENTIALS_FILE).toBeUndefined();
  });

  it.each(["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"])(
    "throws when %s is set in <cwd>/.env",
    (key) => {
      fs.writeFileSync(path.join(dir, ".env"), `OTHER=1\n${key}="abc"\n`);
      expect(() => assertTelemetryDisabled({}, dir)).toThrow(key);
    },
  );

  it("ignores empty values in env and in .env", () => {
    fs.writeFileSync(path.join(dir, ".env"), "MOZAIK_API_KEY=\nMOZAIK_PROJECT_KEY=\n");
    const env: NodeJS.ProcessEnv = { MOZAIK_API_KEY: "", MOZAIK_PROJECT_KEY: "  " };
    expect(() => assertTelemetryDisabled(env, dir)).not.toThrow();
  });

  it("accepts a missing .env and points MOZAIK_CREDENTIALS_FILE at a nonexistent path", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "x" };
    assertTelemetryDisabled(env, dir);
    expect(env.MOZAIK_CREDENTIALS_FILE).toBeTruthy();
    expect(fs.existsSync(env.MOZAIK_CREDENTIALS_FILE!)).toBe(false);
  });
});
