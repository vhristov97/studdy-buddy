import { describe, expect, it } from "vitest";
import { validQuiz } from "./fixtures";
import { PublicQuestion, toPublicQuestion } from "./public";
import { Quiz } from "./quiz";

const quiz = Quiz.parse(validQuiz);
const SECRET_KEYS = ["answer", "explanation", "keyPoints", "tolerance"];

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe("toPublicQuestion", () => {
  it.each(quiz.questions.map((q) => [q.type, q] as const))(
    "drops every secret of a %s question",
    (_type, q) => {
      const pub = toPublicQuestion(q);
      const keys = keysDeep(pub);
      for (const secret of SECRET_KEYS) expect(keys.has(secret)).toBe(false);
      expect(PublicQuestion.parse(pub)).toEqual(pub);
      expect(pub).toMatchObject({ id: q.id, type: q.type, topic: q.topic, prompt: q.prompt });
    },
  );

  it("keeps the per-type presentation fields", () => {
    const [mc, num, match, open] = quiz.questions.map(toPublicQuestion);
    expect(mc).toMatchObject({ options: ["Latenciju", "Propusnost", "Memoriju"] });
    expect(num).toMatchObject({ unit: "min" });
    expect(match).toMatchObject({ rows: ["Kafka", "Spark"], choices: ["Obrada", "Log"] });
    expect(Object.keys(open!).sort()).toEqual(["extra", "id", "prompt", "ref", "topic", "type"]);
  });

  it("does not leak a field the public builder does not copy", () => {
    const source = { ...quiz.questions[0]!, futureSecret: "x" } as never;
    expect(keysDeep(toPublicQuestion(source)).has("futureSecret")).toBe(false);
  });

  it("does not share arrays with the source", () => {
    const mc = quiz.questions[0]!;
    const pub = toPublicQuestion(mc);
    if (pub.type !== "mc") throw new Error("expected mc");
    expect(pub.options).not.toBe((mc as { options: string[] }).options);
  });
});
