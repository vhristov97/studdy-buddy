import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "./client";

describe("apiGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Headers {
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    return new Headers(init.headers);
  }

  it("sends Accept: application/json", async () => {
    const fetchMock = stubFetch();
    await expect(apiGet("/api/x")).resolves.toEqual({ ok: true });
    expect(sentHeaders(fetchMock).get("Accept")).toBe("application/json");
  });

  it("keeps headers passed as a Headers instance", async () => {
    const fetchMock = stubFetch();
    await apiGet("/api/x", { headers: new Headers({ "X-Test": "a" }) });
    const headers = sentHeaders(fetchMock);
    expect(headers.get("X-Test")).toBe("a");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("keeps headers passed as [name, value] pairs", async () => {
    const fetchMock = stubFetch();
    await apiGet("/api/x", { headers: [["X-Test", "b"]] });
    const headers = sentHeaders(fetchMock);
    expect(headers.get("X-Test")).toBe("b");
    expect(headers.get("Accept")).toBe("application/json");
  });
});
