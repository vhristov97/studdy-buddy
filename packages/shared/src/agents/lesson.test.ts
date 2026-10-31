import { describe, expect, it } from "vitest";
import { LessonDraft, LessonTopic } from "./lesson";

const topic = {
  name: "Batch obrada",
  misconceptions: [{ claim: "Batch je uvek sporiji", correction: "Batch optimizuje propusnost." }],
  deferred: false,
  deferredNote: null,
};

describe("LessonDraft", () => {
  it("accepts a lesson with topics", () => {
    const draft = { lessonMd: "Uvod.\n\n## Batch", topics: [topic] };
    expect(LessonDraft.parse(draft)).toEqual(draft);
  });

  it("rejects an empty lesson and an empty topic list", () => {
    expect(LessonDraft.safeParse({ lessonMd: "", topics: [topic] }).success).toBe(false);
    expect(LessonDraft.safeParse({ lessonMd: "x", topics: [] }).success).toBe(false);
  });

  it("rejects more than 40 topics", () => {
    const topics = Array.from({ length: 41 }, (_, i) => ({ ...topic, name: `Tema ${i}` }));
    expect(LessonDraft.safeParse({ lessonMd: "x", topics }).success).toBe(false);
    expect(LessonDraft.safeParse({ lessonMd: "x", topics: topics.slice(0, 40) }).success).toBe(
      true,
    );
  });
});

describe("LessonTopic", () => {
  it("requires deferredNote to be present, though it may be null", () => {
    const withoutNote: Record<string, unknown> = { ...topic };
    delete withoutNote.deferredNote;
    expect(LessonTopic.safeParse(withoutNote).success).toBe(false);
    expect(
      LessonTopic.safeParse({ ...topic, deferred: true, deferredNote: "Kasnije." }).success,
    ).toBe(true);
  });

  it("rejects an empty name and a misconception with an empty correction", () => {
    expect(LessonTopic.safeParse({ ...topic, name: "" }).success).toBe(false);
    expect(
      LessonTopic.safeParse({ ...topic, misconceptions: [{ claim: "a", correction: "" }] }).success,
    ).toBe(false);
  });
});
