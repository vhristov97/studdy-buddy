import {
  SituationSpecification,
  createAgent,
  type InferenceInput,
  type SemanticEvent,
  type Tool,
} from "@mozaik-ai/core";
import { z } from "zod";
import { STAGE_FAILED, join, leave, runLoop, type StageFailedPayload } from "./runtime.js";
import { toStructuredOutputSchema } from "./structured-output.js";

export interface StageSpec<T> {
  /** Agent name, e.g. "quiz-builder". */
  name: string;
  /** Developer message (the agent's instruction). */
  instruction: string;
  /** Callers pass config.MODEL_PLANNER / config.MODEL_BUILDER. */
  model: string;
  schema: z.ZodType<T>;
  schemaName: string;
  /** Per `send`, repairs included. Default 15 minutes. */
  timeoutMs?: number;
  /** Default 32000. Anthropic requires `max_tokens`, and Mozaik forwards it unset otherwise. */
  maxOutputTokens?: number;
  reasoningEffort?: string;
  /** Default true: the Anthropic SDK rejects long non-streaming requests, and it gives progress. */
  streaming?: boolean;
  /** How often to ask the model to fix an invalid answer within one `send`. Default 1. */
  repairAttempts?: number;
  tools?: Tool[];
  /** Receives this agent's loop events (inference.stream, function_call.*, ...). `model.answer` excluded. */
  onEvent?: (event: SemanticEvent) => void;
}

export type StageErrorKind = "failed" | "timeout" | "invalid_json" | "schema" | "closed";

export class StageError extends Error {
  readonly kind: StageErrorKind;
  /** The model's last answer text, for `invalid_json` and `schema`. */
  readonly rawText?: string;
  /** Parse error or Zod issues, for `invalid_json` and `schema`. */
  readonly issues?: unknown;

  constructor(
    kind: StageErrorKind,
    message: string,
    details: { rawText?: string; issues?: unknown; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "StageError";
    this.kind = kind;
    if (details.rawText !== undefined) this.rawText = details.rawText;
    if (details.issues !== undefined) this.issues = details.issues;
  }
}

export interface StageSession<T> {
  readonly agentId: string;
  /** One at a time. The agent keeps its conversation, so later sends see earlier ones. */
  send(message: string): Promise<T>;
  /** Idempotent. Removes the agent from the runtime and rejects a pending send. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

class AnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: StageError) => void;
  timer: NodeJS.Timeout;
  repairsLeft: number;
}

function answerText(event: SemanticEvent): string | undefined {
  const text = (event.payload as { answer?: { content?: { text?: unknown } } } | undefined)?.answer
    ?.content?.text;
  return typeof text === "string" ? text : undefined;
}

function repairMessage(problem: string): string {
  return (
    `Your previous answer could not be accepted:\n${problem}\n\n` +
    "Reply again with only the corrected JSON answer, matching the required schema exactly."
  );
}

/**
 * Opens a multi-turn conversation with one fresh agent. Every `send` runs a loop on the same
 * agent and memory context, so the model sees earlier messages and answers. Used directly for
 * builder fix cycles; `runStage` covers the single-shot case.
 */
export function openStageSession<T>(spec: StageSpec<T>): StageSession<T> {
  // Converting first means an unsupported schema throws before an agent joins the runtime.
  const structuredOutput = {
    name: spec.schemaName,
    schema: toStructuredOutputSchema(spec.schema),
    strict: true,
  };
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const agent = createAgent({
    name: spec.name,
    capabilities: ["inference"],
    instruction: spec.instruction,
    tools: spec.tools ?? [],
    handlers: [],
  });
  const agentId = agent.getId();
  const context = agent.getMemory().getContext();

  let closed = false;
  let pending: Pending<T> | undefined;

  function settle(p: Pending<T>): void {
    clearTimeout(p.timer);
    if (pending === p) pending = undefined;
  }

  function fail(p: Pending<T>, error: StageError, closeSession: boolean): void {
    settle(p);
    p.reject(error);
    if (closeSession) close();
  }

  function startLoop(message: string): void {
    const input: InferenceInput = {
      model: spec.model,
      context,
      streaming: spec.streaming ?? true,
      maxOutputTokens: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      structuredOutput,
    };
    if (spec.reasoningEffort) input.reasoningEffort = spec.reasoningEffort;
    if (spec.tools && spec.tools.length > 0) input.tools = spec.tools;
    runLoop(agentId, message, input);
  }

  /** Starts a loop for the pending send; any synchronous failure rejects it instead of throwing. */
  function startLoopFor(p: Pending<T>, message: string): void {
    try {
      startLoop(message);
    } catch (error) {
      fail(
        p,
        new StageError("failed", `Could not start ${spec.name}: ${String(error)}`, {
          cause: error,
        }),
        true,
      );
    }
  }

  function onAnswer(p: Pending<T>, rawText: string): void {
    let problem: string;
    let issues: unknown;
    let kind: "invalid_json" | "schema";

    let json: unknown;
    let parsedJson = false;
    try {
      json = JSON.parse(rawText);
      parsedJson = true;
    } catch (error) {
      kind = "invalid_json";
      problem = `The answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      issues = error instanceof Error ? error.message : String(error);
    }

    if (parsedJson) {
      const result = spec.schema.safeParse(json);
      if (result.success) {
        settle(p);
        p.resolve(result.data);
        return;
      }
      kind = "schema";
      problem = `The JSON does not match the schema:\n${z.prettifyError(result.error)}`;
      issues = result.error.issues;
    }

    if (p.repairsLeft > 0) {
      p.repairsLeft--;
      const message = repairMessage(problem!);
      // Start the next loop outside the publish call stack of this answer.
      void Promise.resolve().then(() => {
        if (!closed && pending === p) startLoopFor(p, message);
      });
      return;
    }
    fail(
      p,
      new StageError(kind!, `${spec.name} returned an unusable answer: ${problem!}`, {
        rawText,
        issues,
      }),
      false,
    );
  }

  function handle(event: SemanticEvent): void {
    if (closed) return;
    if (event.type === STAGE_FAILED) {
      const payload = event.payload as StageFailedPayload;
      if (payload.contextId !== context.id || !pending) return;
      fail(pending, new StageError("failed", `${spec.name} failed: ${payload.error}`), true);
      return;
    }
    if (event.producerId !== agentId || event.type.startsWith("participant.")) return;
    if (event.type === "model.answer") {
      // ResilientRunner publishes stage.failed (which closes this session) before it returns
      // its placeholder answer, so a placeholder never reaches here: `closed` drops it above.
      const text = answerText(event);
      if (text === undefined || !pending) return;
      onAnswer(pending, text);
      return;
    }
    spec.onEvent?.(event);
  }

  agent.setHandlers([
    {
      specification: new AnyEvent(),
      processor: {
        // Handlers run inside `publish`; a throw here would break the producing agent's loop.
        apply: ({ event }) => {
          try {
            handle(event);
          } catch {
            // Deliberately swallowed: see above. onEvent errors land here too.
          }
        },
      },
    },
  ]);
  join(agent);

  function close(): void {
    if (closed) return;
    closed = true;
    const p = pending;
    if (p) {
      settle(p);
      p.reject(new StageError("closed", `${spec.name} session closed`));
    }
    try {
      leave(agent);
    } catch {
      // Already gone.
    }
  }

  async function send(message: string): Promise<T> {
    if (closed) throw new StageError("closed", `${spec.name} session is closed`);
    if (pending) throw new Error(`${spec.name}: a send is already pending on this session`);
    return new Promise<T>((resolve, reject) => {
      const p: Pending<T> = {
        resolve,
        reject,
        repairsLeft: spec.repairAttempts ?? 1,
        timer: setTimeout(() => {
          fail(p, new StageError("timeout", `${spec.name} timed out after ${timeoutMs} ms`), true);
        }, timeoutMs),
      };
      pending = p;
      startLoopFor(p, message);
    });
  }

  return { agentId, send, close };
}

/** One-shot stage: open a session, send one message, always close. */
export async function runStage<T>(spec: StageSpec<T>, message: string): Promise<T> {
  const session = openStageSession(spec);
  try {
    return await session.send(message);
  } finally {
    session.close();
  }
}
