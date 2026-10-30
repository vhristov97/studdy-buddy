import {
  ModelMessageItem,
  SemanticEvent,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
} from "@mozaik-ai/core";

/**
 * Text of the placeholder answer a failed inference ends with. Consumers must ignore it:
 * the `stage.failed` event is published first and is the real signal.
 */
export const FAILED_PLACEHOLDER = '{"__stageFailed":true}';

export interface RunnerFailure {
  contextId: string;
  error: unknown;
}

export interface ResilientRunnerLogger {
  warn(obj: object, msg: string): void;
}

export interface ResilientRunnerOptions {
  /** Called at most once per `run`/`stream` call, after retries are exhausted or on a non-transient error. */
  onFailure: (failure: RunnerFailure) => void;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Delay before the first retry, doubled for each further one. Default 2000. */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: ResilientRunnerLogger;
}

const TRANSIENT_STATUSES = new Set([408, 409, 429]);
const TRANSIENT_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

/**
 * Transient = worth retrying: HTTP 408/409/429/5xx (529 included) and connection/timeout
 * errors. Detected structurally so we don't depend on the Anthropic SDK's classes.
 */
export function isTransientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; name?: unknown; code?: unknown };
  if (typeof e.status === "number") {
    return TRANSIENT_STATUSES.has(e.status) || e.status >= 500;
  }
  if (typeof e.name === "string" && TRANSIENT_NAMES.has(e.name)) return true;
  const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof ctorName === "string" && TRANSIENT_NAMES.has(ctorName)) return true;
  return typeof e.code === "string" && TRANSIENT_CODES.has(e.code);
}

function placeholderOutput(): InferenceOutput {
  return {
    items: [ModelMessageItem.rehydrate({ text: FAILED_PLACEHOLDER })],
    tokenUsage: undefined,
    rowResponse: undefined,
  };
}

/**
 * Wraps an InferenceRunner with retry on transient errors. It never throws: Mozaik's agent
 * loop does not catch runner errors, so a rejection would surface as an unhandled promise
 * rejection with no event published. Instead, on final failure it reports through
 * `onFailure` and returns a placeholder assistant message, so the loop ends cleanly through
 * `model.answer`.
 */
export class ResilientRunner implements InferenceRunner {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: InferenceRunner,
    private readonly options: ResilientRunnerOptions,
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 2000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.run(input);
      } catch (error) {
        if (await this.shouldRetry(error, attempt)) continue;
        return this.fail(input, error);
      }
    }
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const event of this.inner.stream(input)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        // Once an event went out we can't replay the stream, so only retry before that.
        if (!yielded && (await this.shouldRetry(error, attempt))) continue;
        yield SemanticEvent.create("inference.output", "system", this.fail(input, error));
        return;
      }
    }
  }

  private async shouldRetry(error: unknown, attempt: number): Promise<boolean> {
    if (attempt >= this.maxRetries || !isTransientError(error)) return false;
    const delay =
      this.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 0.1 * this.baseDelayMs);
    this.options.logger?.warn(
      { err: error, attempt: attempt + 1, delayMs: delay },
      "transient inference error, retrying",
    );
    await this.sleep(delay);
    return true;
  }

  private fail(input: InferenceInput, error: unknown): InferenceOutput {
    this.options.logger?.warn({ err: error }, "inference failed");
    this.options.onFailure({ contextId: input.context.id, error });
    return placeholderOutput();
  }
}
