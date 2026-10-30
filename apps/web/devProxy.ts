import { loadEnv } from "vite";

const DEFAULT_API_PORT = "3000";

/**
 * Port of the API server the dev proxy targets. Reads PORT from the `.env` in `envDir` (the repo
 * root, same file the server loads); an already-set `processEnv.PORT` wins, default 3000.
 */
export function resolveApiPort(
  mode: string,
  envDir: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const fileEnv = loadEnv(mode, envDir, "");
  return processEnv.PORT || fileEnv.PORT || DEFAULT_API_PORT;
}
