import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repo root (apps/server/src -> repo root), independent of the cwd. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
