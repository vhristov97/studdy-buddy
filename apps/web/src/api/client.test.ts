import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiUpload } from "./client";

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

  it("preserves a caller-supplied Accept header", async () => {
    const fetchMock = stubFetch();
    await apiGet("/api/x", { headers: { accept: "application/vnd.example+json" } });
    expect(sentHeaders(fetchMock).get("Accept")).toBe("application/vnd.example+json");
  });
});

describe("error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(response: Response) {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("throws an ApiError carrying the parsed ApiErrorBody", async () => {
    stubResponse(
      new Response(
        JSON.stringify({
          error: {
            code: "validation",
            message: "Invalid request body",
            details: [{ path: ["name"] }],
          },
        }),
        { status: 400 },
      ),
    );
    const err = await apiGet("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: "validation",
      message: "Invalid request body",
      details: [{ path: ["name"] }],
    });
  });

  it("falls back to a generic message for a non-JSON body", async () => {
    stubResponse(
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const err = await apiGet("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, message: "HTTP 502 Bad Gateway", code: undefined });
  });

  it("falls back when the JSON is not an ApiErrorBody", async () => {
    stubResponse(new Response(JSON.stringify({ oops: true }), { status: 500 }));
    await expect(apiGet("/api/x")).rejects.toMatchObject({ status: 500, message: "HTTP 500" });
  });
});

describe("write helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  }

  it("apiPost and apiPatch send a JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiPost("/api/courses", { name: "A" })).resolves.toEqual({ id: 1 });
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe("/api/courses");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"A"}');
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    fetchMock.mockClear();
    await apiPatch("/api/courses/1", { name: "B" });
    expect(lastCall(fetchMock)[1].method).toBe("PATCH");
  });

  it("apiDelete resolves on 204", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiDelete("/api/courses/1")).resolves.toBeUndefined();
    expect(lastCall(fetchMock)[1].method).toBe("DELETE");
  });

  it("apiUpload sends multipart with a files part per file and no manual Content-Type", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const a = new File(["%PDF-1"], "a.pdf", { type: "application/pdf" });
    const b = new File(["# n"], "b.md", { type: "text/markdown" });
    await apiUpload("/api/classes/5/materials", [a, b]);
    const [, init] = lastCall(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    const parts = form.getAll("files") as File[];
    expect(parts.map((p) => p.name)).toEqual(["a.pdf", "b.md"]);
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("apiUpload surfaces the server's error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "conflict", message: "x.pdf is already in this class" },
            }),
            { status: 409 },
          ),
      ),
    );
    await expect(apiUpload("/api/classes/5/materials", [])).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      message: "x.pdf is already in this class",
    });
  });
});
