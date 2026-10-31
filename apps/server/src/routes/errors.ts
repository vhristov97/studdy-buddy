import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiErrorBody, ApiErrorCode } from "@studdy/shared";
import { ConflictError } from "../repositories/courses.js";

/** Thrown by route handlers; the error handler turns it into an `ApiErrorBody` response. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

function errorBody(code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

const IdParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

/** Parses a path parameter as a positive integer id; throws a 400 otherwise. */
export function parseId(name: string, value: unknown): number {
  const parsed = IdParam.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "validation", `${name} must be a positive integer`);
  }
  return parsed.data;
}

/** Parses a request body with a shared schema; throws a 400 with the Zod issues in `details`. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, "validation", "Invalid request body", parsed.error.issues);
  }
  return parsed.data;
}

/** Makes every error response, including unexpected ones, an `ApiErrorBody`. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | ConflictError, request, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof ConflictError) {
      return reply.code(409).send(errorBody("conflict", err.message));
    }
    // Fastify's own client errors: malformed JSON, unsupported media type, payload too large, ...
    const status = "statusCode" in err ? err.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const code = status === 404 ? "not_found" : "validation";
      return reply.code(status).send(errorBody(code, err.message));
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("internal", "Internal server error"));
  });
}
