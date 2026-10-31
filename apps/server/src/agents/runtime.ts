import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { RuntimeState, SemanticEvent, defineRuntime, type InferenceRunner } from "@mozaik-ai/core";
import { REPO_ROOT } from "../paths.js";
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

export interface TelemetryDetectionOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Directory holding the app's `.env`. Tests point this at a temp dir. */
  repoRoot?: string;
}

/** Same lookup as the SDK's `readAll()`: any failure to read or parse means "no credentials". */
function hasCachedCredentials(file: string): boolean {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return false;
    return Object.values(raw).some(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { projectKey?: unknown }).projectKey === "string",
    );
  } catch {
    return false;
  }
}

/**
 * `@mozaik-ai/core` bundles a cloud SDK that uploads every event, including full agent
 * memory (study materials), to app.jigjoy.ai when it finds a key or paired credentials. This
 * is allowed (the user's hackathon decision); the function reports which sources turn it on,
 * mirroring the SDK's lookup: `env`, `<cwd>/.env` (which the SDK also reads),
 * `<repoRoot>/.env` (checked explicitly so detection does not depend on `config.ts` having
 * loaded it) and the paired-credentials file (`MOZAIK_CREDENTIALS_FILE` or
 * `~/.mozaik/credentials.json`). Empty or whitespace values count as unset. Never includes
 * secret values. Returns an empty array when telemetry is off.
 */
export function detectTelemetry(options: TelemetryDetectionOptions = {}): string[] {
  const { env = process.env, cwd = process.cwd(), repoRoot = REPO_ROOT } = options;
  const found: string[] = [];
  for (const key of TELEMETRY_KEYS) {
    if (env[key]?.trim()) found.push(`${key} (environment)`);
  }
  const envFiles = new Set([path.join(cwd, ".env"), path.join(repoRoot, ".env")]);
  for (const envFile of envFiles) {
    if (!fs.existsSync(envFile)) continue;
    const parsed = parseEnv(fs.readFileSync(envFile, "utf8"));
    for (const key of TELEMETRY_KEYS) {
      if (parsed[key]?.trim()) found.push(`${key} (${envFile})`);
    }
  }
  const credentialsFile =
    env.MOZAIK_CREDENTIALS_FILE ?? path.join(os.homedir(), ".mozaik", "credentials.json");
  if (hasCachedCredentials(credentialsFile)) found.push(`paired credentials (${credentialsFile})`);
  return found;
}

/**
 * Logs one warning naming the telemetry sources when Mozaik cloud telemetry is on. Call it
 * once at startup, after the logger exists (it is not part of `initAgentRuntime` because the
 * server's logger is only available after the runtime is initialized).
 */
export function warnIfTelemetryOn(
  logger: Pick<ResilientRunnerLogger, "warn">,
  options?: TelemetryDetectionOptions,
): void {
  const sources = detectTelemetry(options);
  if (sources.length === 0) return;
  logger.warn(
    { sources },
    "Mozaik cloud telemetry is on: agent events, including study materials, are uploaded to app.jigjoy.ai",
  );
}

type AppRuntime = ReturnType<typeof app.initializeRuntime>;

let initialized: AppRuntime | undefined;

export interface InitAgentRuntimeOptions {
  /** Replaces the default `ResilientRunner(default runner)`, e.g. a `FakeRunner` in tests. Ignored after the first call. */
  runner?: InferenceRunner;
  /** Accepted for callers (tests) that pass them; telemetry detection now lives in `warnIfTelemetryOn`. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  repoRoot?: string;
  /** Logs retries and failures of the default runner. */
  logger?: ResilientRunnerLogger;
}

/** Idempotent: later calls return the runtime created by the first one. */
export function initAgentRuntime(options: InitAgentRuntimeOptions = {}): AppRuntime {
  if (initialized) return initialized;
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
