import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SituationSpecification,
  createAgent,
  createHuman,
  type Agent,
  type Tool,
  type Participant,
  type SemanticEvent,
} from "@mozaik-ai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAILED_PLACEHOLDER, ResilientRunner } from "./resilient-runner.js";
import {
  STAGE_FAILED,
  initAgentRuntime,
  join,
  leave,
  publishStageFailed,
  runLoop,
  type StageFailedPayload,
} from "./runtime.js";
import { FakeRunner, fakeAnswer, fakeToolCall, type FakeResponder } from "./testing/fake-runner.js";

class AnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

/** Joins an observer that records every event, and resolves waiters on matching ones. */
function observe() {
  const events: SemanticEvent[] = [];
  const human = createHuman({
    name: "observer",
    capabilities: [],
    handlers: [
      {
        specification: new AnyEvent(),
        processor: {
          apply: ({ event }) => {
            events.push(event);
          },
        },
      },
    ],
  });
  join(human);
  return { events, human };
}

async function waitFor(events: SemanticEvent[], match: (e: SemanticEvent) => boolean) {
  for (let i = 0; i < 200; i++) {
    const found = events.find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for event");
}

function answerText(event: SemanticEvent): string {
  return (event.payload as { answer: { content: { text: string } } }).answer.content.text;
}

describe("agent runtime with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let responder: FakeResponder;
  let inner: FakeRunner;
  const cleanup: Participant[] = [];

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-runtime-test-"));
    inner = new FakeRunner((input, i) => responder(input, i));
    initAgentRuntime({
      cwd: tmpCwd,
      repoRoot: tmpCwd,
      runner: new ResilientRunner(inner, {
        onFailure: publishStageFailed,
        sleep: async () => {},
      }),
    });
  });

  afterAll(() => {
    for (const p of cleanup) leave(p);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  function newAgent(tools: Tool[] = []): Agent {
    const agent = createAgent({
      name: "test-agent",
      capabilities: [],
      instruction: "Be brief.",
      tools,
      handlers: [],
    });
    join(agent);
    cleanup.push(agent);
    return agent;
  }

  function start(agent: Agent, extra: { streaming?: boolean; tools?: Tool[] } = {}) {
    runLoop(agent.getId(), "hi", {
      model: "claude-sonnet-5-5",
      context: agent.getMemory().getContext(),
      ...extra,
    });
  }

  it("is idempotent", () => {
    const first = initAgentRuntime({ cwd: tmpCwd, repoRoot: tmpCwd });
    expect(initAgentRuntime({ cwd: tmpCwd, repoRoot: tmpCwd })).toBe(first);
  });

  it("delivers the fake answer as model.answer", async () => {
    responder = () => fakeAnswer("hello there");
    const { events, human } = observe();
    cleanup.push(human);
    const agent = newAgent();
    start(agent);
    const answer = await waitFor(
      events,
      (e) => e.type === "model.answer" && e.producerId === agent.getId(),
    );
    expect(answerText(answer)).toBe("hello there");
    const call = inner.calls.at(-1)!;
    expect(call.model).toBe("claude-sonnet-5-5");
    expect(call.context.id).toBe(agent.getMemory().getContext().id);
  });

  it("works through the streaming path too", async () => {
    responder = () => fakeAnswer("streamed answer");
    const { events, human } = observe();
    cleanup.push(human);
    const agent = newAgent();
    start(agent, { streaming: true });
    const answer = await waitFor(
      events,
      (e) => e.type === "model.answer" && e.producerId === agent.getId(),
    );
    expect(answerText(answer)).toBe("streamed answer");
  });

  it("invokes the agent's tool, then returns the final answer", async () => {
    const invoked: unknown[] = [];
    const tool: Tool = {
      type: "function",
      name: "add",
      description: "adds",
      parameters: { type: "object" },
      strict: false,
      invoke: async (args: { a: number; b: number }) => {
        invoked.push(args);
        return { sum: args.a + args.b };
      },
    };
    const callsBefore = inner.calls.length;
    // callIndex is global to the shared runner, so index relative to this test.
    responder = (_input, i) =>
      i === callsBefore ? fakeToolCall("add", { a: 1, b: 2 }) : fakeAnswer("3");
    const { events, human } = observe();
    cleanup.push(human);
    const agent = newAgent([tool]);
    start(agent, { tools: [tool] });
    const answer = await waitFor(
      events,
      (e) => e.type === "model.answer" && e.producerId === agent.getId(),
    );
    expect(answerText(answer)).toBe("3");
    expect(invoked).toEqual([{ a: 1, b: 2 }]);
    expect(inner.calls.length - callsBefore).toBe(2);
    const types = agent
      .getMemory()
      .getContext()
      .getItems()
      .map((i) => i.type);
    expect(types).toContain("function_call_output");
  });

  it("publishes stage.failed then a placeholder answer when the runner fails", async () => {
    responder = () => Object.assign(new Error("bad request"), { status: 400 });
    const { events, human } = observe();
    cleanup.push(human);
    const agent = newAgent();
    start(agent);
    const answer = await waitFor(
      events,
      (e) => e.type === "model.answer" && e.producerId === agent.getId(),
    );
    expect(answerText(answer)).toBe(FAILED_PLACEHOLDER);
    const relevant = events.filter((e) => e.type === STAGE_FAILED || e.type === "model.answer");
    expect(relevant.map((e) => e.type)).toEqual([STAGE_FAILED, "model.answer"]);
    expect(relevant[0]!.producerId).toBe("system");
    const payload = relevant[0]!.payload as StageFailedPayload;
    expect(payload).toEqual({
      contextId: agent.getMemory().getContext().id,
      error: "bad request",
    });
  });
});
