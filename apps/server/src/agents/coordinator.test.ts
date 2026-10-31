import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SemanticEvent } from "@mozaik-ai/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Coordinator,
  DOMAIN_EVENTS,
  HANDLER_FAILED,
  type HandlerFailedPayload,
} from "./coordinator.js";
import { ResilientRunner } from "./resilient-runner.js";
import { STAGE_FAILED, initAgentRuntime, publishStageFailed } from "./runtime.js";
import { runStage } from "./stage.js";
import { FakeRunner, fakeJsonAnswer, type FakeResponder } from "./testing/fake-runner.js";

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Coordinator with FakeRunner (no API)", () => {
  let tmpCwd: string;
  let responder: FakeResponder;
  const logged: Array<{ obj: object; msg: string }> = [];
  const logger = { error: (obj: object, msg: string) => logged.push({ obj, msg }) };
  const running: Coordinator[] = [];

  function newCoordinator(): Coordinator {
    const c = new Coordinator({ logger });
    c.start();
    running.push(c);
    return c;
  }

  beforeAll(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-coordinator-test-"));
    const inner = new FakeRunner((input, i) => responder(input, i));
    initAgentRuntime({
      cwd: tmpCwd,
      runner: new ResilientRunner(inner, { onFailure: publishStageFailed, sleep: async () => {} }),
    });
  });

  afterEach(() => {
    for (const c of running.splice(0)) c.stop();
    logged.length = 0;
  });

  afterAll(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("reacts to a domain event by running a stage and emitting the next event", async () => {
    responder = () => fakeJsonAnswer({ greeting: "zdravo" });
    const coordinator = newCoordinator();
    const received: SemanticEvent[] = [];
    coordinator.subscribe((e) => received.push(e));

    coordinator.on<{ name: string }>(DOMAIN_EVENTS.DEMO_REQUESTED, async ({ name }) => {
      const result = await runStage(
        {
          name: "demo",
          instruction: "Greet.",
          model: "claude-sonnet-5-5",
          schema: z.object({ greeting: z.string() }),
          schemaName: "demo",
        },
        name,
      );
      coordinator.emit(DOMAIN_EVENTS.DEMO_READY, result);
    });

    coordinator.emit(DOMAIN_EVENTS.DEMO_REQUESTED, { name: "Ana" });
    await waitFor(() => received.some((e) => e.type === DOMAIN_EVENTS.DEMO_READY));

    expect(received.map((e) => e.type)).toEqual([
      DOMAIN_EVENTS.DEMO_REQUESTED,
      DOMAIN_EVENTS.DEMO_READY,
    ]);
    expect(received[1]!.payload).toEqual({ greeting: "zdravo" });
    expect(received[1]!.producerId).toBe(coordinator.id);
  });

  it("runs handlers detached from emit", async () => {
    const coordinator = newCoordinator();
    const order: string[] = [];
    coordinator.on("demo.requested", () => {
      order.push("handler");
    });
    coordinator.emit("demo.requested", {});
    order.push("after emit");
    await waitFor(() => order.includes("handler"));
    expect(order).toEqual(["after emit", "handler"]);
  });

  it("reports a throwing handler as coordinator.handler_failed and keeps working", async () => {
    const coordinator = newCoordinator();
    const received: SemanticEvent[] = [];
    coordinator.subscribe((e) => received.push(e));
    let calls = 0;
    coordinator.on("demo.requested", () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });
    coordinator.on("demo.requested", async () => {
      throw new Error("async boom");
    });

    coordinator.emit("demo.requested", {});
    await waitFor(() => received.filter((e) => e.type === HANDLER_FAILED).length === 2);
    const failures = received
      .filter((e) => e.type === HANDLER_FAILED)
      .map((e) => e.payload as HandlerFailedPayload);
    expect(failures).toEqual(
      expect.arrayContaining([
        { eventType: "demo.requested", error: "boom" },
        { eventType: "demo.requested", error: "async boom" },
      ]),
    );
    expect(logged.map((l) => l.msg)).toContain("coordinator handler failed");

    // Still alive: the handler runs again on the next event.
    coordinator.emit("demo.requested", {});
    await waitFor(() => calls === 2);
  });

  it("does not loop when a handler_failed handler throws", async () => {
    const coordinator = newCoordinator();
    let calls = 0;
    coordinator.on(HANDLER_FAILED, () => {
      calls++;
      throw new Error("again");
    });
    coordinator.on("demo.requested", () => {
      throw new Error("first");
    });
    coordinator.emit("demo.requested", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  it("a throwing subscriber does not break other subscribers or the coordinator", async () => {
    const coordinator = newCoordinator();
    const got: string[] = [];
    coordinator.subscribe(() => {
      throw new Error("bad listener");
    });
    const unsubscribe = coordinator.subscribe((e) => got.push(e.type));
    coordinator.emit(DOMAIN_EVENTS.DEMO_READY, { x: 1 });
    coordinator.emit(DOMAIN_EVENTS.DEMO_READY, { x: 2 });
    expect(got).toEqual([DOMAIN_EVENTS.DEMO_READY, DOMAIN_EVENTS.DEMO_READY]);
    expect(logged.some((l) => l.msg === "coordinator listener failed")).toBe(true);

    unsubscribe();
    coordinator.emit(DOMAIN_EVENTS.DEMO_READY, { x: 3 });
    expect(got).toHaveLength(2);
  });

  it("forwards stage.failed to subscribers", async () => {
    responder = () => Object.assign(new Error("bad request"), { status: 400 });
    const coordinator = newCoordinator();
    const types: string[] = [];
    coordinator.subscribe((e) => types.push(e.type));
    await runStage(
      {
        name: "demo",
        instruction: "x",
        model: "claude-sonnet-5-5",
        schema: z.object({}),
        schemaName: "demo",
      },
      "go",
    ).catch(() => {});
    expect(types).toContain(STAGE_FAILED);
  });

  it("ignores domain events from other coordinators in its subscriber feed", () => {
    const a = newCoordinator();
    const b = newCoordinator();
    const seenByA: string[] = [];
    a.subscribe((e) => seenByA.push(e.type));
    b.emit("demo.ready", {});
    expect(seenByA).toEqual([]);
  });

  it("refuses to emit before start and stops reacting after stop", async () => {
    const coordinator = new Coordinator({ logger });
    expect(() => coordinator.emit("demo.ready", {})).toThrow(/not started/);
    coordinator.start();
    let calls = 0;
    coordinator.on("demo.ready", () => {
      calls++;
    });
    const other = newCoordinator();
    other.emit("demo.ready", {});
    await waitFor(() => calls === 1);
    coordinator.stop();
    other.emit("demo.ready", {});
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
  });
});
