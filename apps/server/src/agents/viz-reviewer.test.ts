import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateVizHtml, type VizReview } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import {
  VIZ_APPROVED,
  VIZ_HTML,
  VIZ_REJECTED,
  vizPlanFixture,
} from "./testing/viz-build-fixtures.js";
import {
  buildVizReviewerInstruction,
  buildVizReviewerMessage,
  reviewViz,
  vizReviewSchema,
  vizReviewerSpec,
  type VizReviewerInput,
} from "./viz-reviewer.js";

function reviewInput(): VizReviewerInput {
  return {
    plan: vizPlanFixture(),
    html: VIZ_HTML,
    notes: ["Scenario ispada čvora je nejasan."],
    lessonMd: "LEKCIJA-TEKST",
    report: validateVizHtml(VIZ_HTML),
  };
}

function issuesOf(review: unknown): string {
  const result = vizReviewSchema().safeParse(review);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

const bad: [string, VizReview, string][] = [
  [
    "approved with fixes",
    { ...VIZ_APPROVED, fixes: VIZ_REJECTED.fixes },
    "approved is true but fixes is not empty",
  ],
  [
    "not approved without fixes",
    { ...VIZ_REJECTED, fixes: [] },
    "must list at least one concrete fix",
  ],
];

describe("buildVizReviewerMessage", () => {
  it("includes plan, page, notes, report and lesson", () => {
    const message = buildVizReviewerMessage(reviewInput());
    for (const s of [
      "Plan vizualizacije (JSON)",
      "expectedEndState",
      "<stranica>",
      "Dodaj čvor",
      "- Scenario ispada čvora je nejasan.",
      "Errors (0):",
      "LEKCIJA-TEKST",
    ]) {
      expect(message).toContain(s);
    }
  });

  it("says when the builder left no notes", () => {
    expect(buildVizReviewerMessage({ ...reviewInput(), notes: [] })).toContain(
      "nije ostavio beleške",
    );
  });
});

describe("buildVizReviewerInstruction", () => {
  it("asks to walk the scenarios, check the controls and the contract", () => {
    const text = buildVizReviewerInstruction();
    for (const s of ["for EACH scenario", "expectedEndState", "Controls:", "dopuna", "390 px"]) {
      expect(text).toContain(s);
    }
  });
});

describe("vizReviewerSpec", () => {
  it("uses the planner model and a convertible schema", () => {
    const spec = vizReviewerSpec();
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.name).toBe("viz-reviewer");
    expect(spec.schemaName).toBe("viz_review");
    expect(spec.maxOutputTokens).toBe(16_000);
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("vizReviewSchema", () => {
  it("accepts approval without fixes and rejection with fixes", () => {
    expect(issuesOf(VIZ_APPROVED)).toBe("");
    expect(issuesOf(VIZ_REJECTED)).toBe("");
  });

  it.each(bad)("rejects %s", (_label, review, expected) => {
    expect(issuesOf(review)).toContain(expected);
  });
});

describe("reviewViz with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-vizreview-test-"));
    inner = new FakeRunner((_input, i) => queue[i] ?? new Error(`unexpected call ${i}`));
    initAgentRuntime({
      cwd: tmpCwd,
      repoRoot: tmpCwd,
      runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });

  beforeEach(() => {
    queue = [];
    inner.calls.length = 0;
  });

  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns an approval and a rejection", async () => {
    queue = [fakeJsonAnswer(VIZ_APPROVED)];
    await expect(reviewViz(reviewInput())).resolves.toEqual(VIZ_APPROVED);
    expect(inner.calls[0]!.model).toBe(config.MODEL_PLANNER);
    queue = [fakeJsonAnswer(VIZ_REJECTED)];
    inner.calls.length = 0;
    await expect(reviewViz(reviewInput())).resolves.toEqual(VIZ_REJECTED);
  });

  it.each(bad)("repairs %s", async (_label, review) => {
    queue = [fakeJsonAnswer(review), fakeJsonAnswer(VIZ_REJECTED)];
    await expect(reviewViz(reviewInput())).resolves.toEqual(VIZ_REJECTED);
    expect(inner.calls).toHaveLength(2);
  });
});
