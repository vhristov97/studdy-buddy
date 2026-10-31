import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VizPlan } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import { MISCONCEPTION, ctxFixture } from "./testing/quiz-fixtures.js";
import { vizSuggestionFixture } from "./testing/viz-fixtures.js";
import { vizPlanFixture } from "./testing/viz-build-fixtures.js";
import {
  buildVizPlannerInstruction,
  buildVizPlannerMessage,
  planViz,
  vizPlanSchema,
  vizPlannerSpec,
  type VizPlannerInput,
} from "./viz-planner.js";

function input(origin: "agent" | "user" = "agent"): VizPlannerInput {
  return {
    ctx: ctxFixture(),
    suggestion:
      origin === "agent"
        ? { ...vizSuggestionFixture(), origin }
        : {
            concept: "CAP teorema",
            section: "",
            misconception: "Particija mreže",
            summary: "Particija mreže",
            controls: [],
            scenarios: [],
            origin,
          },
  };
}

function issuesOf(plan: unknown): string {
  const result = vizPlanSchema().safeParse(plan);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

const control = (name: string) => ({ name, effect: "Menja prikaz." });
const scenario = (name: string, steps = ["Klikni"]) => ({
  name,
  steps,
  expectedEndState: "Stanje.",
});

const bad: [string, VizPlan, string][] = [
  ["a 1-word title", vizPlanFixture({ title: "Sharding" }), "has 1 words; it needs 2 to 4"],
  [
    "a 5-word title",
    vizPlanFixture({ title: "Jedan dva tri četiri pet" }),
    "has 5 words; it needs 2 to 4",
  ],
  ["a slug with capitals", vizPlanFixture({ slug: "Sharding-Lupom" }), "must be lowercase ASCII"],
  ["a slug with diacritics", vizPlanFixture({ slug: "čvor-lupom" }), "must be lowercase ASCII"],
  ["a slug with a double hyphen", vizPlanFixture({ slug: "a--b" }), "must be lowercase ASCII"],
  ["a too long slug", vizPlanFixture({ slug: "a".repeat(61) }), "must be lowercase ASCII"],
  ["one control", vizPlanFixture({ controls: [control("A")] }), "has 1 controls; it needs 2 to 6"],
  [
    "seven controls",
    vizPlanFixture({ controls: "ABCDEFG".split("").map(control) }),
    "has 7 controls; it needs 2 to 6",
  ],
  [
    "duplicate control names",
    vizPlanFixture({ controls: [control("Dodaj"), control(" dodaj ")] }),
    'control name "dodaj" is used twice',
  ],
  [
    "one scenario",
    vizPlanFixture({ scenarios: [scenario("A")] }),
    "has 1 scenarios; it needs 2 to 5",
  ],
  [
    "six scenarios",
    vizPlanFixture({ scenarios: "ABCDEF".split("").map((n) => scenario(n)) }),
    "has 6 scenarios; it needs 2 to 5",
  ],
  [
    "duplicate scenario names",
    vizPlanFixture({ scenarios: [scenario("A"), scenario("a")] }),
    'scenario name "a" is used twice',
  ],
  [
    "a scenario without steps",
    vizPlanFixture({ scenarios: [scenario("A"), scenario("B", [])] }),
    'Scenario "B" needs at least one step',
  ],
];

describe("buildVizPlannerMessage", () => {
  it("carries the lesson, topics with history and the approved suggestion", () => {
    const message = buildVizPlannerMessage(input());
    for (const s of [
      "Kurs: Kurs za test",
      "Predavanje 2: Obrada podataka",
      "<lekcija>",
      "## Batch obrada",
      MISCONCEPTION,
      "Odobrena tema",
      "Koncept: Sharding pod lupom",
      "Odeljak lekcije: Obrada podataka › Batch obrada",
      "- klizač: broj čvorova",
      "- Ispad čvora: ugasi čvor 2",
    ]) {
      expect(message).toContain(s);
    }
  });

  it("gives only the concept and note for a user topic", () => {
    const message = buildVizPlannerMessage(input("user"));
    expect(message).toContain("Tema koju je student sam dodao");
    expect(message).toContain("Koncept: CAP teorema");
    expect(message).toContain("Napomena studenta: Particija mreže");
    expect(message).not.toContain("Odeljak lekcije:");
    expect(message).not.toContain("Predložene kontrole");
  });

  it("says when a user topic has no note", () => {
    const message = buildVizPlannerMessage({
      ...input("user"),
      suggestion: { ...input("user").suggestion, misconception: "" },
    });
    expect(message).toContain("Napomena studenta: nema.");
  });
});

describe("buildVizPlannerInstruction", () => {
  it("adds the persona when set", () => {
    expect(buildVizPlannerInstruction(null)).not.toContain("You are also");
    expect(buildVizPlannerInstruction("iskusni data inženjer")).toContain(
      "You are also iskusni data inženjer",
    );
  });

  it("covers the spec's plan parts", () => {
    const text = buildVizPlannerInstruction(null);
    for (const s of ["wrongModelPredicts", "vizShows", "dopuna", "expectedEndState", "2-4 words"]) {
      expect(text).toContain(s);
    }
  });
});

describe("vizPlannerSpec", () => {
  it("uses the planner model and a convertible schema", () => {
    const spec = vizPlannerSpec(input());
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.name).toBe("viz-planner");
    expect(spec.schemaName).toBe("viz_plan");
    expect(spec.maxOutputTokens).toBe(16_000);
    expect(spec.repairAttempts).toBe(2);
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("vizPlanSchema", () => {
  it("accepts a valid plan", () => {
    expect(issuesOf(vizPlanFixture())).toBe("");
  });

  it.each(bad)("rejects %s", (_label, plan, expected) => {
    expect(issuesOf(plan)).toContain(expected);
  });
});

describe("planViz with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-vizplan-test-"));
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

  it("returns the parsed plan on the planner model", async () => {
    queue = [fakeJsonAnswer(vizPlanFixture())];
    await expect(planViz(input())).resolves.toEqual(vizPlanFixture());
    expect(inner.calls[0]!.model).toBe(config.MODEL_PLANNER);
  });

  it.each(bad)("repairs %s", async (_label, plan) => {
    queue = [fakeJsonAnswer(plan), fakeJsonAnswer(vizPlanFixture())];
    await expect(planViz(input())).resolves.toEqual(vizPlanFixture());
    expect(inner.calls).toHaveLength(2);
  });
});
