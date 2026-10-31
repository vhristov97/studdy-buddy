import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InferenceInput, SemanticEvent, Tool } from "@mozaik-ai/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ResilientRunner } from "./resilient-runner.js";
import { initAgentRuntime, publishStageFailed, resolveRuntime } from "./runtime.js";
import { StageError, openStageSession, runStage, type StageSpec } from "./stage.js";
import { toStructuredOutputSchema } from "./structured-output.js";
import {
  FakeRunner,
  fakeAnswer,
  fakeJsonAnswer,
  type FakeResponder,
} from "./testing/fake-runner.js";

const schema = z.object({ n: z.number(), label: z.string().nullable() });
type Result = z.infer<typeof schema>;

function spec(overrides: Partial<StageSpec<Result>> = {}): StageSpec<Result> {
  return {
    name: "test-stage",
    instruction: "You are a test stage.",
    model: "claude-sonnet-5-5",
    schema,
    schemaName: "test_result",
    ...overrides,
  };
}

/** Message items of a context as "role: text", in order. */
function transcript(input: InferenceInput): string[] {
  return input.context
    .getItems()
    .filter((i) => i.type === "message")
    .map((i) => {
      const m = i as unknown as { role: string; content: { text: string } };
      return `${m.role}: ${m.content.text}`;
    });
}

function agentExists(agentId: string): boolean {
  try {
    resolveRuntime().getParticipant(agentId);
    return true;
  } catch {
    return false;
  }
}

describe("stage helpers with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let responder: FakeResponder;
  let inner: FakeRunner;
  /** Transcript of each call, captured when the call happens (contexts are mutated in place). */
  let seen: string[][];

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-stage-test-"));
    inner = new FakeRunner((input, i) => {
      seen.push(transcript(input));
      return responder(input, i);
    });
    initAgentRuntime({
      cwd: tmpCwd,
      runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });

  beforeEach(() => {
    seen = [];
    inner.calls.length = 0;
  });

  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns the typed result and sends the converted schema with the default options", async () => {
    responder = () => fakeJsonAnswer({ n: 1, label: null });
    const events: SemanticEvent[] = [];
    const result = await runStage(spec({ onEvent: (e) => events.push(e) }), "go");
    expect(result).toEqual({ n: 1, label: null });

    expect(inner.calls).toHaveLength(1);
    const call = inner.calls[0]!;
    expect(call.model).toBe("claude-sonnet-5-5");
    expect(call.streaming).toBe(true);
    expect(call.maxOutputTokens).toBe(32000);
    expect(call.reasoningEffort).toBeUndefined();
    expect(call.tools).toBeUndefined();
    expect(call.structuredOutput).toEqual({
      name: "test_result",
      schema: toStructuredOutputSchema(schema),
      strict: true,
    });
    expect(seen[0]).toEqual(["developer: You are a test stage.", "user: go"]);

    const agentId = events[0]!.producerId;
    expect(agentExists(agentId)).toBe(false);
  });

  it("passes explicit options through", async () => {
    responder = () => fakeJsonAnswer({ n: 1, label: "x" });
    const tool: Tool = {
      type: "function",
      name: "noop",
      description: "does nothing",
      parameters: { type: "object" },
      strict: false,
      invoke: async () => "ok",
    };
    await runStage(
      spec({
        streaming: false,
        maxOutputTokens: 1234,
        reasoningEffort: "high",
        model: "claude-opus-5-5",
        tools: [tool],
      }),
      "go",
    );
    const call = inner.calls[0]!;
    expect(call.streaming).toBe(false);
    expect(call.maxOutputTokens).toBe(1234);
    expect(call.reasoningEffort).toBe("high");
    expect(call.model).toBe("claude-opus-5-5");
    expect(call.tools).toEqual([tool]);
  });

  it("repairs invalid JSON in the same session", async () => {
    responder = (_input, i) =>
      i === 0 ? fakeAnswer("not json {") : fakeJsonAnswer({ n: 2, label: "ok" });
    const result = await runStage(spec(), "go");
    expect(result).toEqual({ n: 2, label: "ok" });
    expect(seen).toHaveLength(2);
    const second = seen[1]!;
    expect(second.slice(0, 3)).toEqual([
      "developer: You are a test stage.",
      "user: go",
      "assistant: not json {",
    ]);
    expect(second[3]).toMatch(/^user: .*not valid JSON/s);
    expect(second[3]).toMatch(/corrected JSON/);
  });

  it("fails with invalid_json when the repair is also not JSON", async () => {
    responder = (_input, i) => fakeAnswer(i === 0 ? "nope" : "still nope");
    const error = await runStage(spec(), "go").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageError);
    const stageError = error as StageError;
    expect(stageError.kind).toBe("invalid_json");
    expect(stageError.rawText).toBe("still nope");
    expect(stageError.issues).toBeTruthy();
    expect(seen).toHaveLength(2);
  });

  it("repairs a schema mismatch and includes the Zod issues in the correction", async () => {
    responder = (_input, i) =>
      i === 0 ? fakeJsonAnswer({ n: "one", label: null }) : fakeJsonAnswer({ n: 1, label: null });
    const result = await runStage(spec(), "go");
    expect(result).toEqual({ n: 1, label: null });
    expect(seen[1]!.at(-1)).toMatch(/does not match the schema[\s\S]*n/);
  });

  it("fails with schema (and issues) when the repair still mismatches", async () => {
    responder = () => fakeJsonAnswer({ n: "one" });
    const error = (await runStage(spec(), "go").catch((e: unknown) => e)) as StageError;
    expect(error).toBeInstanceOf(StageError);
    expect(error.kind).toBe("schema");
    expect(error.rawText).toBe('{"n":"one"}');
    expect(Array.isArray(error.issues)).toBe(true);
    expect((error.issues as unknown[]).length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
  });

  it("does not repair when repairAttempts is 0", async () => {
    responder = () => fakeAnswer("bad");
    const error = (await runStage(spec({ repairAttempts: 0 }), "go").catch(
      (e: unknown) => e,
    )) as StageError;
    expect(error.kind).toBe("invalid_json");
    expect(seen).toHaveLength(1);
  });

  it("rejects with failed when the runner fails, and ignores the placeholder answer", async () => {
    responder = () => Object.assign(new Error("bad request"), { status: 400 });
    const session = openStageSession(spec());
    const error = (await session.send("go").catch((e: unknown) => e)) as StageError;
    expect(error).toBeInstanceOf(StageError);
    expect(error.kind).toBe("failed");
    expect(error.message).toMatch(/bad request/);
    expect(agentExists(session.agentId)).toBe(false);
    // Let the placeholder answer and any stray rejection surface; vitest fails on unhandled ones.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
  });

  it("rejects with timeout and closes the session", async () => {
    responder = () => new Promise(() => {});
    const session = openStageSession(spec({ timeoutMs: 50 }));
    const error = (await session.send("go").catch((e: unknown) => e)) as StageError;
    expect(error.kind).toBe("timeout");
    expect(agentExists(session.agentId)).toBe(false);
    const again = (await session.send("again").catch((e: unknown) => e)) as StageError;
    expect(again.kind).toBe("closed");
  });

  it("keeps the conversation across sends in one session", async () => {
    responder = (_input, i) => fakeJsonAnswer({ n: i + 1, label: null });
    const session = openStageSession(spec());
    expect(agentExists(session.agentId)).toBe(true);
    expect(await session.send("first")).toEqual({ n: 1, label: null });
    expect(await session.send("second")).toEqual({ n: 2, label: null });
    expect(seen[1]).toEqual([
      "developer: You are a test stage.",
      "user: first",
      'assistant: {"n":1,"label":null}',
      "user: second",
    ]);

    session.close();
    session.close();
    expect(agentExists(session.agentId)).toBe(false);
    const error = (await session.send("third").catch((e: unknown) => e)) as StageError;
    expect(error).toBeInstanceOf(StageError);
    expect(error.kind).toBe("closed");
  });

  it("rejects a pending send with closed when the session is closed", async () => {
    responder = () => new Promise(() => {});
    const session = openStageSession(spec());
    const pending = session.send("go");
    session.close();
    expect(((await pending.catch((e: unknown) => e)) as StageError).kind).toBe("closed");
  });

  it("allows only one send at a time", async () => {
    responder = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return fakeJsonAnswer({ n: 1, label: null });
    };
    const session = openStageSession(spec());
    const first = session.send("a");
    await expect(session.send("b")).rejects.toThrow(/already pending/);
    expect(await first).toEqual({ n: 1, label: null });
    session.close();
  });

  it("keeps parallel stages apart even when answers arrive out of order", async () => {
    responder = async (input) => {
      const instruction = transcript(input)[0]!;
      const slow = instruction.includes("slow");
      await new Promise((r) => setTimeout(r, slow ? 80 : 5));
      return fakeJsonAnswer({ n: slow ? 1 : 2, label: slow ? "slow" : "fast" });
    };
    const [a, b] = await Promise.all([
      runStage(spec({ instruction: "slow agent" }), "go"),
      runStage(spec({ instruction: "fast agent" }), "go"),
    ]);
    expect(a).toEqual({ n: 1, label: "slow" });
    expect(b).toEqual({ n: 2, label: "fast" });
  });

  it("a failure in one stage does not reject another", async () => {
    responder = async (input) => {
      if (transcript(input)[0]!.includes("doomed")) {
        return Object.assign(new Error("bad request"), { status: 400 });
      }
      await new Promise((r) => setTimeout(r, 30));
      return fakeJsonAnswer({ n: 7, label: null });
    };
    const [doomed, fine] = await Promise.allSettled([
      runStage(spec({ instruction: "doomed agent" }), "go"),
      runStage(spec({ instruction: "fine agent" }), "go"),
    ]);
    expect(doomed.status).toBe("rejected");
    expect((doomed as PromiseRejectedResult).reason.kind).toBe("failed");
    expect(fine).toEqual({ status: "fulfilled", value: { n: 7, label: null } });
  });

  it("forwards the agent's loop events to onEvent", async () => {
    responder = () => fakeJsonAnswer({ n: 1, label: null });
    const events: SemanticEvent[] = [];
    await runStage(spec({ onEvent: (e) => events.push(e) }), "go");
    const types = events.map((e) => e.type);
    expect(types).toContain("inference.stream");
    expect(types).toContain("inference.completed");
    expect(types).not.toContain("model.answer");
    expect(types.some((t) => t.startsWith("participant."))).toBe(false);
    expect(new Set(events.map((e) => e.producerId)).size).toBe(1);
  });

  it("survives a throwing onEvent", async () => {
    responder = () => fakeJsonAnswer({ n: 1, label: null });
    const result = await runStage(
      spec({
        onEvent: () => {
          throw new Error("ui broke");
        },
      }),
      "go",
    );
    expect(result).toEqual({ n: 1, label: null });
  });

  it("throws on open for a schema it cannot convert, without joining an agent", () => {
    const bad = z.object({ m: z.record(z.string(), z.string()) });
    expect(() =>
      openStageSession({ ...spec(), schema: bad as unknown as z.ZodType<Result> }),
    ).toThrow(/record/);
  });
});
