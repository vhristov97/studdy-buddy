import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LessonDraft } from "@studdy/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import {
  buildLessonWriterInstruction,
  buildLessonWriterMessage,
  lessonDraftSchema,
  lessonWriterSpec,
  writeLesson,
  type LessonWriterInput,
} from "./lesson-writer.js";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponse } from "./testing/fake-runner.js";

function input(overrides: Partial<LessonWriterInput> = {}): LessonWriterInput {
  return {
    course: { name: "Kurs za test", persona: null, assessmentFormat: null },
    class: { number: 3, title: "Replikacija" },
    materials: [{ name: "slajdovi.pdf", text: "--- strana 1 ---\n## Replikacija\n- Master-slave" }],
    notes: [{ name: "beleske.md", text: "Predavač: ~~sve~~ je važno" }],
    ...overrides,
  };
}

function draft(overrides: Partial<LessonDraft> = {}): LessonDraft {
  return {
    lessonMd: "Uvod.\n\n## Replikacija\n\n- Master-slave\n- (P) Važno za ispit.",
    topics: [{ name: "Replikacija", misconceptions: [], deferred: false, deferredNote: null }],
    ...overrides,
  };
}

function parseIssues(schema: ReturnType<typeof lessonDraftSchema>, value: unknown): string {
  const result = schema.safeParse(value);
  return result.success ? "" : result.error.issues.map((i) => i.message).join("\n");
}

describe("buildLessonWriterMessage", () => {
  it("includes every material and note with its name and text", () => {
    const message = buildLessonWriterMessage(
      input({
        materials: [
          { name: "a.pdf", text: "TEKST-A" },
          { name: "b.html", text: "TEKST-B" },
        ],
        notes: [
          { name: "n1.md", text: "BELESKA-1" },
          { name: "n2.md", text: "BELESKA-2" },
        ],
      }),
    );
    for (const s of ["a.pdf", "TEKST-A", "b.html", "TEKST-B", "n1.md", "BELESKA-1", "n2.md"]) {
      expect(message).toContain(s);
    }
    expect(message).toContain("BELESKA-2");
    expect(message).toContain("Predavanje 3: Replikacija");
    expect(message).toContain("Kurs: Kurs za test");
  });

  it("states that there are no notes, and has no notes block, when notes are empty", () => {
    const message = buildLessonWriterMessage(input({ notes: [] }));
    expect(message).toContain("nema beleški");
    expect(message).not.toContain("<beleske");
  });

  it("includes the assessment format only when set", () => {
    expect(buildLessonWriterMessage(input())).not.toContain("Format ocenjivanja");
    const message = buildLessonWriterMessage(
      input({
        course: { name: "K", persona: null, assessmentFormat: "Usmeni ispit, 30 poena" },
      }),
    );
    expect(message).toContain("Format ocenjivanja:\nUsmeni ispit, 30 poena");
  });
});

describe("buildLessonWriterInstruction", () => {
  it("adds the persona line only when a persona is set", () => {
    const without = buildLessonWriterInstruction(null);
    expect(without).not.toContain("You are also");
    const withPersona = buildLessonWriterInstruction("an experienced data engineer");
    expect(withPersona).toContain("You are also an experienced data engineer;");
    expect(withPersona.startsWith(without)).toBe(true);
  });
});

describe("lessonWriterSpec", () => {
  it("uses the planner model, a large output budget and a convertible schema", () => {
    const spec = lessonWriterSpec(input());
    expect(spec.model).toBe(config.MODEL_PLANNER);
    expect(spec.maxOutputTokens).toBe(64_000);
    expect(spec.name).toBe("lesson-writer");
    expect(spec.schemaName).toBe("lesson_draft");
    expect(spec.repairAttempts).toBe(2);
    expect(() => toStructuredOutputSchema(spec.schema)).not.toThrow();
  });
});

describe("lessonDraftSchema", () => {
  const withNotes = lessonDraftSchema({ hasNotes: true });
  const noNotes = lessonDraftSchema({ hasNotes: false });

  it("accepts a valid draft", () => {
    expect(withNotes.safeParse(draft()).success).toBe(true);
    expect(noNotes.safeParse(draft({ lessonMd: "Uvod.\n\n- Master-slave" })).success).toBe(true);
  });

  it("rejects duplicate topic names ignoring case and whitespace", () => {
    const topic = draft().topics[0]!;
    const issues = parseIssues(
      withNotes,
      draft({ topics: [topic, { ...topic, name: "  replikacija " }] }),
    );
    expect(issues).toContain("duplicates topic #1");
  });

  it("checks deferred against deferredNote", () => {
    const topic = draft().topics[0]!;
    expect(
      parseIssues(withNotes, draft({ topics: [{ ...topic, deferredNote: "kasnije" }] })),
    ).toContain("deferredNote must be null");
    expect(parseIssues(withNotes, draft({ topics: [{ ...topic, deferred: true }] }))).toContain(
      "must say what was promised",
    );
    expect(
      parseIssues(withNotes, draft({ topics: [{ ...topic, deferred: true, deferredNote: "  " }] })),
    ).toContain("must say what was promised");
    expect(
      withNotes.safeParse(
        draft({ topics: [{ ...topic, deferred: true, deferredNote: "Kasnije." }] }),
      ).success,
    ).toBe(true);
  });

  it("rejects the knowledge-tracking table", () => {
    const md = "Uvod.\n\n| Tema | Ocena | Testirano | Napomene |\n|---|---|---|---|\n| A | ? | | |";
    expect(parseIssues(withNotes, draft({ lessonMd: md }))).toContain("knowledge-tracking table");
    // Other tables are fine.
    expect(
      withNotes.safeParse(draft({ lessonMd: "Uvod.\n\n| Pojam | Opis |\n|---|---|\n| A | b |" }))
        .success,
    ).toBe(true);
  });

  it("forbids (P), Ispravka and misconceptions without notes", () => {
    const topic = draft().topics[0]!;
    expect(parseIssues(noNotes, draft())).toContain("(P) tag");
    expect(parseIssues(noNotes, draft({ lessonMd: "Uvod.\n\n> ⚠️ Ispravka: a — b" }))).toContain(
      "Ispravka callout",
    );
    expect(
      parseIssues(
        noNotes,
        draft({
          lessonMd: "Uvod.",
          topics: [{ ...topic, misconceptions: [{ claim: "a", correction: "b" }] }],
        }),
      ),
    ).toContain("no notes");
  });

  it("requires an Ispravka callout when misconceptions exist", () => {
    const topic = draft().topics[0]!;
    const misconceptions = [{ claim: "a", correction: "b" }];
    expect(parseIssues(withNotes, draft({ topics: [{ ...topic, misconceptions }] }))).toContain(
      "Ispravka",
    );
    expect(
      withNotes.safeParse(
        draft({
          lessonMd: "Uvod.\n\n- Tačno.\n\n> ⚠️ Ispravka: a — b",
          topics: [{ ...topic, misconceptions }],
        }),
      ).success,
    ).toBe(true);
  });
});

describe("writeLesson with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let queue: FakeResponse[];
  let inner: FakeRunner;

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-lesson-test-"));
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

  it("returns the parsed draft", async () => {
    const answer = draft();
    queue = [fakeJsonAnswer(answer)];
    await expect(writeLesson(input())).resolves.toEqual(answer);
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.model).toBe(config.MODEL_PLANNER);
  });

  it("repairs a (P) tag in a no-notes lesson", async () => {
    queue = [
      fakeJsonAnswer(draft()),
      fakeJsonAnswer(draft({ lessonMd: "Uvod.\n\n- Master-slave" })),
    ];
    const result = await writeLesson(input({ notes: [] }));
    expect(result.lessonMd).not.toContain("(P)");
    expect(inner.calls).toHaveLength(2);
  });

  it.each([
    [
      "duplicate topic names",
      () => {
        const t = draft().topics[0]!;
        return draft({ topics: [t, { ...t, name: "REPLIKACIJA" }] });
      },
    ],
    [
      "a tracking table",
      () => draft({ lessonMd: "Uvod.\n\n| Tema | Ocena |\n|---|---|\n| A | ? |" }),
    ],
    [
      "deferred without a note",
      () => draft({ topics: [{ ...draft().topics[0]!, deferred: true }] }),
    ],
    [
      "misconceptions without a callout",
      () =>
        draft({
          topics: [{ ...draft().topics[0]!, misconceptions: [{ claim: "a", correction: "b" }] }],
        }),
    ],
  ])("repairs %s", async (_label, bad) => {
    queue = [fakeJsonAnswer(bad()), fakeJsonAnswer(draft())];
    await expect(writeLesson(input())).resolves.toEqual(draft());
    expect(inner.calls).toHaveLength(2);
  });

  it("throws without calling the runner when there are no materials", async () => {
    await expect(writeLesson(input({ materials: [] }))).rejects.toThrow(/materials/);
    expect(inner.calls).toHaveLength(0);
  });
});
