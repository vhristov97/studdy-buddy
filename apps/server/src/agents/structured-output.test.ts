import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toStructuredOutputSchema } from "./structured-output.js";

// Loose view of the converted schema for assertions.
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("toStructuredOutputSchema", () => {
  const schema = z.object({
    title: z.string().min(3).max(80),
    difficulty: z.enum(["easy", "hard"]),
    hint: z.string().nullable(),
    score: z.number().int().min(0).max(10),
    questions: z
      .array(
        z.object({
          text: z.string().min(1),
          options: z.array(z.string()).min(2).max(6),
          tags: z.array(z.string()).min(1),
        }),
      )
      .min(1),
  });

  const json = toStructuredOutputSchema(schema) as Json;

  it("drops $schema", () => {
    expect(json.$schema).toBeUndefined();
  });

  it("closes objects at every level and requires all properties", () => {
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(["title", "difficulty", "hint", "score", "questions"]);
    const question = json.properties.questions.items;
    expect(question.additionalProperties).toBe(false);
    expect(question.required).toEqual(["text", "options", "tags"]);
  });

  it("strips unsupported keywords but keeps the rest", () => {
    expect(json.properties.title).toEqual({ type: "string" });
    expect(json.properties.score.minimum).toBeUndefined();
    expect(json.properties.score.maximum).toBeUndefined();
    expect(json.properties.score.type).toBe("integer");
    expect(json.properties.questions.items.properties.text).toEqual({ type: "string" });
  });

  it("keeps minItems of 1 and drops larger values and maxItems", () => {
    expect(json.properties.questions.minItems).toBe(1);
    const options = json.properties.questions.items.properties.options;
    expect(options.minItems).toBeUndefined();
    expect(options.maxItems).toBeUndefined();
    expect(json.properties.questions.items.properties.tags.minItems).toBe(1);
  });

  it("keeps enums and nullable unions", () => {
    expect(json.properties.difficulty.enum).toEqual(["easy", "hard"]);
    expect(json.properties.hint.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
  });

  it("does not treat property names as keywords", () => {
    const out = toStructuredOutputSchema(z.object({ minimum: z.string(), pattern: z.string() }));
    expect(Object.keys((out as Json).properties)).toEqual(["minimum", "pattern"]);
  });

  it("recurses into unions and shared definitions", () => {
    const item = z.object({ n: z.number().min(1) });
    const out = toStructuredOutputSchema(
      z.object({ a: z.union([item, z.string().email()]), b: z.array(item) }),
    ) as Json;
    const [first, second] = out.properties.a.anyOf;
    expect(first.additionalProperties).toBe(false);
    expect(first.properties.n.minimum).toBeUndefined();
    expect(second.format).toBeUndefined();
  });

  it("rejects records", () => {
    expect(() =>
      toStructuredOutputSchema(z.object({ m: z.record(z.string(), z.string()) })),
    ).toThrow(/record/);
  });
});
