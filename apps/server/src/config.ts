import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./paths.js";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATA_DIR: z.string().min(1).default("./data"),
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  ANTHROPIC_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  MODEL_PLANNER: z.string().min(1).default("claude-opus-5-5"),
  MODEL_BUILDER: z.string().min(1).default("claude-sonnet-5-5"),
});

export interface Config {
  readonly PORT: number;
  readonly HOST: string;
  /** Absolute path. */
  readonly DATA_DIR: string;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  /**
   * Optional Anthropic-compatible gateway. The Anthropic SDK reads it from `process.env`
   * (Mozaik passes no base URL), so it is validated and exposed here, not passed through.
   */
  readonly ANTHROPIC_BASE_URL?: string | undefined;
  readonly MODEL_PLANNER: string;
  readonly MODEL_BUILDER: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return Object.freeze({
    ...parsed,
    DATA_DIR: path.resolve(REPO_ROOT, parsed.DATA_DIR),
  });
}

function loadRootEnvFile(): void {
  const envPath = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

loadRootEnvFile();

export const config: Config = loadConfig();
