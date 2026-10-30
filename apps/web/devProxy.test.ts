import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiPort } from "./devProxy";

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
    expect(resolveApiPort("development", dir, {})).toBe("4321");
  });

  it("prefers the process env PORT over the .env file", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=4321\n");
    expect(resolveApiPort("development", dir, { PORT: "5555" })).toBe("5555");
  });

  it("defaults to 3000 when neither is set", () => {
    expect(resolveApiPort("development", dir, {})).toBe("3000");
    fs.writeFileSync(path.join(dir, ".env"), "OTHER=1\n");
    expect(resolveApiPort("development", dir, {})).toBe("3000");
  });
});
