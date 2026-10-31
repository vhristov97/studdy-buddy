import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VizSuggestions } from "@studdy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import { MISCONCEPTION, ctxFixture } from "./testing/quiz-fixtures.js";
import { vizSuggestionFixture, vizSuggestionsFixture } from "./testing/viz-fixtures.js";
import {
  buildVizIdentifierInstruction,
  buildVizIdentifierMessage,
  identifyVizTopics,
  vizIdentifierSpec,
  vizSuggestionsSchema,
  type ExistingVizTopic,
} from "./viz-identifier.js";

function issuesOf(value: unknown, existing: ExistingVizTopic[] = []): string {
  const result = vizSuggestionsSchema(existing).safeParse(value);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

function withSuggestions(
  ...suggestions: ReturnType<typeof vizSuggestionFixture>[]
): VizSuggestions {
  return { suggestions };
}

describe("buildVizIdentifierMessage", () => {
  it("carries the course, class, lesson, topics and their misconceptions", () => {
    const message = buildVizIdentifierMessage({ ctx: ctxFixture(), existing: [] });
    for (const s of [
      "Kurs: Kurs za test",
      "Predavanje 2: Obrada podataka",
      "<lekcija>",
      "## Batch obrada",
      "1. Batch obrada [ocena: ?]",
      "3. Lambda arhitektura [ocena: ?] [ODLOŽENO]",
      `zabluda: "${MISCONCEPTION}"`,
      'ispravno: "Batch optimizuje propusnost, ne latenciju."',
      "Za ovo predavanje još nema predloga ni vizualizacija.",
    ]) {
      expect(message).toContain(s);
    }
  });

  it("lists existing topics so they are not suggested again", () => {
    const message = buildVizIdentifierMessage({
      ctx: ctxFixture(),
      existing: [
        { concept: "Sharding pod lupom", origin: "agent", selected: true },
        { concept: "CAP teorema", origin: "user", selected: false },
      ],
    });
    expect(message).toContain("- Sharding pod lupom (raniji predlog, izabrano)");
    expect(message).toContain("- CAP teorema (dodao student)");
    expect(message).not.toContain("još nema predloga");
  });
});

describe("buildVizIdentifierInstruction", () => {
  it("adds the persona line only when a persona is set", () => {
    const without = buildVizIdentifierInstruction(null);
    expect(without).not.toContain("You are also");
    const withPersona = buildVizIdentifierInstruction("an experienced data engineer");
    expect(withPersona).toContain("You are also an experienced data engineer;");
    expect(withPersona.startsWith(without)).toBe(true);
  });

  it("asks for recommendations only and for Serbian output", () => {
    const instruction = buildVizIdentifierInstruction(null);
    expect(instruction).toContain("You only recommend");
    expect(instruction).toContain("Serbian, Latin script");
  });
});

describe("vizIdentifierSpec", () => {
  it("uses the planner model and a convertible schema", () => {
    const spec = vizIdentifierSpec({ ctx: ctxFixture(), existing: [] });
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.name).toBe("viz-identifier");
    expect(spec.schemaName).toBe("viz_suggestions");
    expect(spec.maxOutputTokens).toBe(8000);
    expect(spec.timeoutMs).toBe(10 * 60 * 1000);
    expect(spec.repairAttempts).toBe(2);
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("vizSuggestionsSchema", () => {
  it("accepts the valid fixture", () => {
    expect(issuesOf(vizSuggestionsFixture())).toBe("");
  });

  it("accepts an empty list (nothing benefits from a visualization)", () => {
    expect(issuesOf({ suggestions: [] })).toBe("");
  });

  it("rejects empty fields", () => {
    expect(issuesOf(withSuggestions(vizSuggestionFixture({ summary: " " })))).not.toBe("");
    expect(issuesOf(withSuggestions(vizSuggestionFixture({ section: "" })))).not.toBe("");
  });

  it("rejects more than five suggestions", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      vizSuggestionFixture({ concept: `Tema ${i}` }),
    );
    expect(issuesOf(withSuggestions(...many))).toContain("at most 5 suggestions");
  });

  it("rejects duplicate concepts case-insensitively", () => {
    const issues = issuesOf(
      withSuggestions(
        vizSuggestionFixture({ concept: "Sharding" }),
        vizSuggestionFixture({ concept: "  sharding " }),
      ),
    );
    expect(issues).toContain("appears twice");
  });

  it("rejects a concept that already exists", () => {
    const issues = issuesOf(withSuggestions(vizSuggestionFixture()), [
      { concept: "SHARDING pod lupom", origin: "user", selected: false },
    ]);
    expect(issues).toContain("already has a suggestion or visualization");
  });

  it("requires 2 to 5 controls and 2 to 4 scenarios", () => {
    expect(issuesOf(withSuggestions(vizSuggestionFixture({ controls: ["jedna"] })))).toContain(
      "has 1 controls; it needs 2 to 5",
    );
    expect(
      issuesOf(withSuggestions(vizSuggestionFixture({ controls: ["a", "b", "c", "d", "e", "f"] }))),
    ).toContain("has 6 controls");
    expect(issuesOf(withSuggestions(vizSuggestionFixture({ scenarios: ["jedan"] })))).toContain(
      "has 1 scenarios; it needs 2 to 4",
    );
    expect(
      issuesOf(withSuggestions(vizSuggestionFixture({ scenarios: ["a", "b", "c", "d", "e"] }))),
    ).toContain("has 5 scenarios");
  });
});

describe("identifyVizTopics", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let runner: FakeRunner;
  let base = 0;
  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-viz-identifier-test-"));
    runner = new FakeRunner((_input, i) => queue[i - base] ?? new Error("queue exhausted"));
    initAgentRuntime({
      cwd: tmpCwd,
      repoRoot: tmpCwd,
      runner: new ResilientRunner(runner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });
  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns the suggestions of a valid answer", async () => {
    queue = [fakeJsonAnswer(vizSuggestionsFixture())];
    const before = (base = runner.calls.length);
    const result = await identifyVizTopics({ ctx: ctxFixture(), existing: [] });
    expect(result.suggestions.map((s) => s.concept)).toEqual([
      "Sharding pod lupom",
      "Lambda u pokretu",
    ]);
    expect(runner.calls.length - before).toBe(1);
  });

  it("accepts an empty list without a repair round", async () => {
    queue = [fakeJsonAnswer({ suggestions: [] })];
    const before = (base = runner.calls.length);
    const result = await identifyVizTopics({ ctx: ctxFixture(), existing: [] });
    expect(result.suggestions).toEqual([]);
    expect(runner.calls.length - before).toBe(1);
  });

  it("repairs an answer that breaks a refinement", async () => {
    const bad = withSuggestions(vizSuggestionFixture({ controls: ["jedna"] }));
    queue = [fakeJsonAnswer(bad), fakeJsonAnswer(vizSuggestionsFixture())];
    const before = (base = runner.calls.length);
    const result = await identifyVizTopics({ ctx: ctxFixture(), existing: [] });
    expect(result.suggestions).toHaveLength(2);
    expect(runner.calls.length - before).toBe(2);
    expect(JSON.stringify(runner.calls[before + 1])).toContain("it needs 2 to 5");
  });
});
