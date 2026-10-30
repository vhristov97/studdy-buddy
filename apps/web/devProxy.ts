import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const DEFAULT_API_PORT = "3000";

/**
 * Port of the API server the dev proxy targets. Reads PORT from the single `.env` in `envDir`
 * (the repo root, the only file the server loads; no `.env.local` / `.env.[mode]` variants). An
 * already-set `processEnv.PORT` wins, default 3000.
 */
export function resolveApiPort(
  envDir: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const envPath = path.join(envDir, ".env");
  const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {};
  return processEnv.PORT || fileEnv.PORT || DEFAULT_API_PORT;
}
