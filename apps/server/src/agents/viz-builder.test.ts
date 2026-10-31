import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InferenceInput } from "@mozaik-ai/core";
import { validateVizHtml, type VizDraft } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";
import { VIZ_HTML, vizDraftFixture, vizPlanFixture } from "./testing/viz-build-fixtures.js";
import {
  buildViz,
  buildVizBuilderInstruction,
  buildVizBuilderMessage,
  buildVizFixMessage,
  openVizBuilderSession,
  vizBuilderSpec,
  vizDraftSchema,
} from "./viz-builder.js";

function issuesOf(draft: unknown, plan = vizPlanFixture()): string {
  const result = vizDraftSchema(plan).safeParse(draft);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

const withHtml = (html: string): VizDraft => vizDraftFixture({ html });

const bad: [string, VizDraft, string][] = [
  [
    "an external script",
    withHtml(VIZ_HTML.replace("<script>", '<script src="https://cdn.test/x.js"></script><script>')),
    "[external_script]",
  ],
  [
    "a page without the viewport meta",
    withHtml(VIZ_HTML.replace(/<meta name="viewport"[^>]*>/, "")),
    "[missing_viewport]",
  ],
  [
    "a page without a dark theme query",
    withHtml(VIZ_HTML.replace(/@media \(prefers-color-scheme: dark\)[^\n]*/, "")),
    "[missing_color_scheme]",
  ],
  [
    "a network call",
    withHtml(VIZ_HTML.replace("<script>", '<script>fetch("/x");')),
    "[network_api]",
  ],
  [
    "a title that differs from the plan",
    withHtml(VIZ_HTML.replace("Sharding pod lupom", "Nešto drugo ovde")),
    'The <title> must be exactly "Sharding pod lupom"',
  ],
];

describe("buildVizBuilderMessage", () => {
  it("carries the plan and the lesson", () => {
    const message = buildVizBuilderMessage({ plan: vizPlanFixture(), lessonMd: "LEKCIJA-TEKST" });
    for (const s of [
      "Plan vizualizacije (JSON)",
      "expectedEndState",
      "<lekcija>",
      "LEKCIJA-TEKST",
    ]) {
      expect(message).toContain(s);
    }
  });
});

describe("buildVizBuilderInstruction", () => {
  it("states the design contract and the output format", () => {
    const text = buildVizBuilderInstruction();
    for (const s of [
      "prefers-color-scheme",
      "390 px",
      "aria-live",
      "prefers-reduced-motion",
      "try/catch",
      '"dopuna"',
      "COMPLETE corrected page",
    ]) {
      expect(text).toContain(s);
    }
  });
});

describe("buildVizFixMessage", () => {
  it("lists the fixes and asks for the complete page", () => {
    const message = buildVizFixMessage([
      {
        area: "scenario: Ispad čvora",
        problem: "Svi ključevi se premeštaju",
        change: "Samo čvor 2",
      },
    ]);
    expect(message).toContain("1. scenario: Ispad čvora: Svi ključevi se premeštaju");
    expect(message).toContain("Izmena: Samo čvor 2");
    expect(message).toContain("KOMPLETNU");
    expect(message).not.toContain("automatske provere");
  });

  it("appends the contract report when it has findings", () => {
    const message = buildVizFixMessage(
      [{ area: "a", problem: "b", change: "c" }],
      validateVizHtml("<html></html>"),
    );
    expect(message).toContain("Izveštaj automatske provere stranice");
    expect(message).toContain("[missing_doctype]");
  });
});

describe("vizBuilderSpec", () => {
  it("uses the builder model and a convertible schema", () => {
    const spec = vizBuilderSpec(vizPlanFixture());
    expect(spec.model).toBe(config.MODEL_BUILDER);
    expect(spec.name).toBe("viz-builder");
    expect(spec.schemaName).toBe("viz_draft");
    expect(spec.maxOutputTokens).toBe(64_000);
    expect(spec.timeoutMs).toBe(30 * 60 * 1000);
    expect(spec.repairAttempts).toBe(2);
    expect(spec.instruction).toBe(buildVizBuilderInstruction());
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("vizDraftSchema", () => {
  it("accepts a page that meets the contract, also with warnings", () => {
    expect(issuesOf(vizDraftFixture())).toBe("");
    const noLive = withHtml(VIZ_HTML.replace(' aria-live="polite"', ""));
    expect(validateVizHtml(noLive.html).warnings.length).toBeGreaterThan(0);
    expect(issuesOf(noLive)).toBe("");
  });

  it.each(bad)("rejects %s", (_label, draft, expected) => {
    expect(issuesOf(draft)).toContain(expected);
  });

  it("requires a dopuna label when the plan lists tutor additions", () => {
    const plan = vizPlanFixture({ dopuna: ["Primer iz prakse"] });
    expect(issuesOf(vizDraftFixture(), plan)).toContain('never labels anything "dopuna"');
    const labeled = withHtml(VIZ_HTML.replace("</body>", "<p>dopuna: primer</p></body>"));
    expect(issuesOf(labeled, plan)).toBe("");
  });
});

function transcript(input: InferenceInput): string[] {
  return input.context
    .getItems()
    .filter((i) => i.type === "message")
    .map((i) => {
      const m = i as unknown as { role: string; content: { text: string } };
      return `${m.role}: ${m.content.text}`;
    });
}

describe("viz builder with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;
  let seen: string[][];

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-vizbuild-test-"));
    inner = new FakeRunner((input, i) => {
      seen.push(transcript(input));
      return queue[i] ?? new Error(`unexpected call ${i}`);
    });
    initAgentRuntime({
      cwd: tmpCwd,
      repoRoot: tmpCwd,
      runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });

  beforeEach(() => {
    queue = [];
    seen = [];
    inner.calls.length = 0;
  });

  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns the parsed draft on the builder model", async () => {
    queue = [fakeJsonAnswer(vizDraftFixture())];
    await expect(buildViz({ plan: vizPlanFixture(), lessonMd: "Lekcija" })).resolves.toEqual(
      vizDraftFixture(),
    );
    expect(inner.calls[0]!.model).toBe(config.MODEL_BUILDER);
  });

  it.each(bad)("repairs %s", async (_label, draft, expected) => {
    queue = [fakeJsonAnswer(draft), fakeJsonAnswer(vizDraftFixture())];
    await expect(buildViz({ plan: vizPlanFixture(), lessonMd: "Lekcija" })).resolves.toEqual(
      vizDraftFixture(),
    );
    expect(inner.calls).toHaveLength(2);
    // the repair message tells the model what was wrong
    expect(seen[1]!.join("\n")).toContain(expected);
  });

  it("keeps the conversation across a build and a fix round in one session", async () => {
    const fixed = withHtml(VIZ_HTML.replace("Čvor dodat", "Čvor dodat; mod N premešta većinu."));
    queue = [fakeJsonAnswer(vizDraftFixture()), fakeJsonAnswer(fixed)];

    const session = openVizBuilderSession(vizPlanFixture());
    try {
      const built = await session.send(
        buildVizBuilderMessage({ plan: vizPlanFixture(), lessonMd: "Lekcija" }),
      );
      expect(built).toEqual(vizDraftFixture());
      const result = await session.send(
        buildVizFixMessage([{ area: "caption", problem: "Prekratko", change: "Dodaj razlog" }]),
      );
      expect(result).toEqual(fixed);
    } finally {
      session.close();
    }

    expect(inner.calls).toHaveLength(2);
    expect(seen[1]!.slice(0, 2)).toEqual(seen[0]);
    expect(seen[1]!.join("\n")).toContain("Dodaj razlog");
    expect(seen[1]!.join("\n")).toContain("Lekcija");
  });
});
