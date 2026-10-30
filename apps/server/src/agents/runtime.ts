import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { RuntimeState, SemanticEvent, defineRuntime, type InferenceRunner } from "@mozaik-ai/core";
import {
  ResilientRunner,
  type ResilientRunnerLogger,
  type RunnerFailure,
} from "./resilient-runner.js";

export class AppState extends RuntimeState {}

/** The single app runtime. Everything else imports join/leave/runLoop/... from here. */
const app = defineRuntime<AppState>();

export const { join, leave, sendEvent, runLoop, resolveRuntime, resolveParticipant } = app;

export const STAGE_FAILED = "stage.failed";

export interface StageFailedPayload {
  contextId: string;
  error: string;
}

/**
 * Mozaik's default (real-API) runner. `InferenceInputValidator` is not exported, so we can't
 * construct `DefaultInferenceRunner` ourselves. A throwaway second runtime, initialized
 * without a runner, builds one for us.
 */
export function createDefaultInferenceRunner(): InferenceRunner {
  const throwaway = defineRuntime<AppState>();
  return throwaway.initializeRuntime({ state: new AppState() }).getInferenceRunner();
}

const TELEMETRY_KEYS = ["MOZAIK_API_KEY", "MOZAIK_PROJECT_KEY"] as const;

/**
 * `@mozaik-ai/core` bundles a cloud SDK that uploads every event, including full agent
 * memory (study materials), to app.jigjoy.ai when a key is found. Refuse to start if one is
 * configured in `env` or in `<cwd>/.env` (which the SDK also reads), and point its paired-
 * credentials lookup at a file that does not exist.
 */
export function assertTelemetryDisabled(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): void {
  const found: string[] = [];
  for (const key of TELEMETRY_KEYS) {
    if (env[key]?.trim()) found.push(`${key} (environment)`);
  }
  const envFile = path.join(cwd, ".env");
  if (fs.existsSync(envFile)) {
    const parsed = parseEnv(fs.readFileSync(envFile, "utf8"));
    for (const key of TELEMETRY_KEYS) {
      if (parsed[key]?.trim()) found.push(`${key} (${envFile})`);
    }
  }
  if (found.length > 0) {
    throw new Error(
      `Mozaik cloud telemetry would upload all agent events, including study materials, to ` +
        `app.jigjoy.ai. Remove ${found.join(", ")} and start again.`,
    );
  }
  env.MOZAIK_CREDENTIALS_FILE = path.join(
    os.tmpdir(),
    "studdy-buddy-mozaik-credentials-disabled.json",
  );
}

type AppRuntime = ReturnType<typeof app.initializeRuntime>;

let initialized: AppRuntime | undefined;

export interface InitAgentRuntimeOptions {
  /** Replaces the default `ResilientRunner(default runner)`, e.g. a `FakeRunner` in tests. Ignored after the first call. */
  runner?: InferenceRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Logs retries and failures of the default runner. */
  logger?: ResilientRunnerLogger;
}

/** Idempotent: later calls return the runtime created by the first one. */
export function initAgentRuntime(options: InitAgentRuntimeOptions = {}): AppRuntime {
  if (initialized) return initialized;
  assertTelemetryDisabled(options.env, options.cwd);
  const runner =
    options.runner ??
    new ResilientRunner(createDefaultInferenceRunner(), {
      onFailure: publishStageFailed,
      ...(options.logger && { logger: options.logger }),
    });
  initialized = app.initializeRuntime({
    state: new AppState(),
    inferenceRunnerConfig: { runner },
  });
  return initialized;
}

/** Publishes `stage.failed`; pass this as `onFailure` when wrapping a runner in a `ResilientRunner`. */
export function publishStageFailed({ contextId, error }: RunnerFailure): void {
  const payload: StageFailedPayload = {
    contextId,
    error: error instanceof Error ? error.message : String(error),
  };
  app.resolveRuntime().publish(SemanticEvent.create(STAGE_FAILED, "system", payload));
}
