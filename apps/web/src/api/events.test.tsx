import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassStatus, GenerationJob } from "@studdy/shared";
import { job } from "../test/utils";
import { useClassEvents } from "./events";
import { queryKeys } from "./keys";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

function setup(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.courses, []);
  client.setQueryData(queryKeys.class(5), { id: 5, status: "generating" });
  client.setQueryData(queryKeys.classJobs(5), [job()]);
  client.setQueryData(queryKeys.lesson(5), {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ on }) => useClassEvents(5, on), {
    wrapper,
    initialProps: { on: enabled },
  });
  return { client, hook };
}

const jobEvent = (over: Partial<GenerationJob>, classStatus: ClassStatus) => ({
  type: "job",
  job: job(over),
  classStatus,
});

const stale = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated === true;

afterEach(() => {
  FakeEventSource.instances = [];
});

describe("useClassEvents", () => {
  it("does nothing without EventSource (jsdom)", () => {
    const { hook } = setup();
    expect(hook.result.current.jobs.size).toBe(0);
  });

  it("opens the class stream only while enabled and closes it on unmount", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { hook } = setup(false);
    expect(FakeEventSource.instances).toHaveLength(0);
    hook.rerender({ on: true });
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/classes/5/events");
    hook.unmount();
    expect(source.closed).toBe(true);
  });

  it("stays open while a quiz job runs on a ready class, even if `enabled` lapses", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { hook } = setup();
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.emit(
        "job",
        jobEvent({ status: "succeeded", finishedAt: "2026-01-01T10:02:00.000Z" }, "ready"),
      );
      source.emit(
        "job",
        jobEvent({ id: 2, kind: "quiz", stage: "quiz-reviewer", cycle: 1 }, "ready"),
      );
    });
    hook.rerender({ on: false });
    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() =>
      source.emit(
        "job",
        jobEvent(
          { id: 2, kind: "quiz", status: "succeeded", finishedAt: "2026-01-01T10:03:00.000Z" },
          "ready",
        ),
      ),
    );
    expect(source.closed).toBe(true);
  });

  it("tracks jobs and progress", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { hook } = setup();
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.emit("job", jobEvent({}, "generating"));
      source.emit("progress", {
        type: "progress",
        classId: 5,
        jobId: 1,
        stage: "lesson-writer",
        outputChars: 4200,
      });
    });
    expect(hook.result.current.jobs.get(1)?.status).toBe("running");
    expect(hook.result.current.progress.get(1)).toBe(4200);
  });

  it("ignores malformed events", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { hook } = setup();
    act(() => {
      FakeEventSource.instances[0]!.listeners.get("job")?.forEach((listener) =>
        listener(new MessageEvent("job", { data: "not json" })),
      );
    });
    expect(hook.result.current.jobs.size).toBe(0);
  });

  it("does not refetch while nothing changed", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { client } = setup();
    act(() => FakeEventSource.instances[0]!.emit("job", jobEvent({}, "generating")));
    expect(stale(client, queryKeys.class(5))).toBe(false);
  });

  it("invalidates class, course, jobs and lesson when a job finishes", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { client } = setup();
    act(() =>
      FakeEventSource.instances[0]!.emit(
        "job",
        jobEvent({ status: "succeeded", finishedAt: "2026-01-01T10:02:00.000Z" }, "ready"),
      ),
    );
    expect(stale(client, queryKeys.class(5))).toBe(true);
    expect(stale(client, queryKeys.classJobs(5))).toBe(true);
    expect(stale(client, queryKeys.lesson(5))).toBe(true);
    expect(stale(client, queryKeys.courses)).toBe(true);
  });
});
