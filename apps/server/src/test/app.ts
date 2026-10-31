import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";

export interface TestApp {
  app: FastifyInstance;
  handle: DatabaseHandle;
  dir: string;
  /** Closes the app and database and removes the temp dir. */
  cleanup: () => Promise<void>;
}

/** A fresh app on a migrated SQLite database in a temp dir. */
export function createTestApp(): TestApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-test-"));
  const handle = openDatabase(dir);
  migrate(handle.db);
  const app = buildApp({ config: loadConfig({ DATA_DIR: dir }), db: handle.db });
  return {
    app,
    handle,
    dir,
    cleanup: async () => {
      await app.close();
      try {
        handle.close();
      } catch {
        // already closed by the test
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
