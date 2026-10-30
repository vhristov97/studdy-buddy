import { SemanticEvent, ModelContext, type InferenceInput } from "@mozaik-ai/core";
import { describe, expect, it } from "vitest";
import { FAILED_PLACEHOLDER, ResilientRunner, type RunnerFailure } from "./resilient-runner.js";
import { FakeRunner, fakeAnswer } from "./testing/fake-runner.js";

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function connectionError(): Error {
  const err = new Error("Connection error.");
  err.name = "APIConnectionError";
  return err;
}

function setup(responses: Array<Error | ReturnType<typeof fakeAnswer>>, maxRetries = 3) {
  const inner = FakeRunner.fromQueue(responses);
  const failures: RunnerFailure[] = [];
  const delays: number[] = [];
  const runner = new ResilientRunner(inner, {
    onFailure: (f) => failures.push(f),
    maxRetries,
    baseDelayMs: 1000,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  const input: InferenceInput = { model: "claude-sonnet-5-5", context: ModelContext.create() };
  return { inner, failures, delays, runner, input };
}

function textOf(output: { items: unknown[] }): string {
  const item = output.items[0] as { content: { text: string } };
  return item.content.text;
}

async function collect(gen: AsyncGenerator<SemanticEvent>): Promise<SemanticEvent[]> {
  const events: SemanticEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("ResilientRunner.run", () => {
  it("passes a successful result through", async () => {
    const { runner, input, inner, failures, delays } = setup([fakeAnswer("ok")]);
    const out = await runner.run(input);
    expect(textOf(out)).toBe("ok");
    expect(inner.calls).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(delays).toEqual([]);
  });

  it("retries a 429 with growing delays, then succeeds", async () => {
    const { runner, input, inner, failures, delays } = setup([
      httpError(429),
      httpError(429),
      httpError(429),
      fakeAnswer("finally"),
    ]);
    const out = await runner.run(input);
    expect(textOf(out)).toBe("finally");
    expect(inner.calls).toHaveLength(4);
    expect(failures).toEqual([]);
    expect(delays).toHaveLength(3);
    // base 1000 doubling, plus < 10% jitter
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(1100);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThan(2100);
    expect(delays[2]).toBeGreaterThanOrEqual(4000);
    expect(delays[2]).toBeLessThan(4100);
  });

  it.each([
    ["529", () => httpError(529)],
    ["500", () => httpError(500)],
    ["408", () => httpError(408)],
    ["connection error", connectionError],
  ])("retries %s", async (_name, make) => {
    const { runner, input, inner, failures } = setup([make(), fakeAnswer("ok")]);
    expect(textOf(await runner.run(input))).toBe("ok");
    expect(inner.calls).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it.each([
    ["400", httpError(400)],
    ["401", httpError(401)],
    ["validation", new Error('Request validation "structured-output" failed for model "x"')],
  ])("does not retry %s", async (_name, error) => {
    const { runner, input, inner, failures, delays } = setup([error, fakeAnswer("unused")]);
    const out = await runner.run(input);
    expect(textOf(out)).toBe(FAILED_PLACEHOLDER);
    expect(inner.calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(failures).toEqual([{ contextId: input.context.id, error }]);
  });

  it("gives up after maxRetries, calls onFailure once and returns the placeholder", async () => {
    const errors = [httpError(503), httpError(503), httpError(503)];
    const { runner, input, inner, failures, delays } = setup(errors, 2);
    const out = await runner.run(input);
    expect(inner.calls).toHaveLength(3);
    expect(delays).toHaveLength(2);
    expect(failures).toEqual([{ contextId: input.context.id, error: errors[2] }]);
    expect(out.items).toHaveLength(1);
    expect(textOf(out)).toBe(FAILED_PLACEHOLDER);
    expect(out.tokenUsage).toBeUndefined();
  });
});

describe("ResilientRunner.stream", () => {
  it("passes events through", async () => {
    const { runner, input } = setup([fakeAnswer("streamed")]);
    const events = await collect(runner.stream(input));
    expect(events.map((e) => e.type)).toEqual(["inference.output"]);
    expect(textOf(events[0]!.payload as { items: unknown[] })).toBe("streamed");
  });

  it("retries a transient error before the first event", async () => {
    const { runner, input, inner, failures, delays } = setup([httpError(529), fakeAnswer("ok")]);
    const events = await collect(runner.stream(input));
    expect(inner.calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(textOf(events[0]!.payload as { items: unknown[] })).toBe("ok");
  });

  it("does not retry after the first event was yielded", async () => {
    let calls = 0;
    const inner = {
      run: () => Promise.reject(new Error("unused")),
      async *stream() {
        calls++;
        yield SemanticEvent.create("inference.stream", "system", { delta: "a" });
        throw httpError(529);
      },
    };
    const failures: RunnerFailure[] = [];
    const runner = new ResilientRunner(inner, {
      onFailure: (f) => failures.push(f),
      sleep: async () => {},
    });
    const input: InferenceInput = { model: "m", context: ModelContext.create() };
    const events = await collect(runner.stream(input));
    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["inference.stream", "inference.output"]);
    expect(textOf(events[1]!.payload as { items: unknown[] })).toBe(FAILED_PLACEHOLDER);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.contextId).toBe(input.context.id);
  });

  it("yields the placeholder output on a non-transient failure", async () => {
    const { runner, input, failures, delays } = setup([httpError(400)]);
    const events = await collect(runner.stream(input));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("inference.output");
    expect(textOf(events[0]!.payload as { items: unknown[] })).toBe(FAILED_PLACEHOLDER);
    expect(failures).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});
