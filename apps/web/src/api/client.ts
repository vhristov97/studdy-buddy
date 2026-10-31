import { ApiErrorBody, type ApiErrorCode } from "@studdy/shared";

export class ApiError extends Error {
  readonly status: number;
  /** The server's error code, or undefined when the body was not an `ApiErrorBody`. */
  readonly code: ApiErrorCode | undefined;
  readonly details: unknown;

  constructor(status: number, message: string, code?: ApiErrorCode, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const fallback = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  try {
    const body = ApiErrorBody.safeParse(await res.json());
    if (body.success) {
      const { code, message, details } = body.data.error;
      return new ApiError(res.status, message, code, details);
    }
  } catch {
    // not JSON: use the generic message
  }
  return new ApiError(res.status, fallback);
}

async function request<T>(path: string, init: RequestInit, json: boolean): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (json && init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, { ...init }, false);
}

/** GET returning the body as text (for stored files such as Markdown notes). */
export async function apiGetText(path: string): Promise<string> {
  const res = await fetch(path, { headers: { Accept: "text/*" } });
  if (!res.ok) throw await toApiError(res);
  return res.text();
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(
    path,
    { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
    true,
  );
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) }, true);
}

export function apiDelete(path: string): Promise<void> {
  return request<void>(path, { method: "DELETE" }, false);
}

/** Multipart upload; every file goes in the `files` field. The browser sets the boundary. */
export function apiUpload<T>(path: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return request<T>(path, { method: "POST", body: form }, false);
}
