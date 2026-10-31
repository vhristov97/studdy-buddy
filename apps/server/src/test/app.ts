import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Coordinator } from "../agents/coordinator.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { migrate, openDatabase, type DatabaseHandle } from "../db/client.js";
import { createPipeline, type Pipeline, type WriteLesson } from "../pipeline/pipeline.js";

export interface TestApp {
  app: FastifyInstance;
  handle: DatabaseHandle;
  dir: string;
  /** Only with `options.pipeline`. */
  coordinator?: Coordinator;
  pipeline?: Pipeline;
  /** Closes the app and database and removes the temp dir. */
  cleanup: () => Promise<void>;
}

export interface TestAppOptions {
  /** Adds a coordinator and pipeline (and so the generate routes). The agent runtime must be initialized. */
  pipeline?: { writeLesson?: WriteLesson; progressIntervalMs?: number };
}

/** A fresh app on a migrated SQLite database in a temp dir. */
export function createTestApp(options: TestAppOptions = {}): TestApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studdy-test-"));
  const handle = openDatabase(dir);
  migrate(handle.db);
  let coordinator: Coordinator | undefined;
  let pipeline: Pipeline | undefined;
  if (options.pipeline) {
    const logger = { error: () => {} };
    coordinator = new Coordinator({ logger });
    coordinator.start();
    pipeline = createPipeline({ db: handle.db, coordinator, logger, ...options.pipeline });
  }
  const app = buildApp({
    config: loadConfig({ DATA_DIR: dir }),
    db: handle.db,
    ...(pipeline && coordinator && { pipeline, coordinator }),
  });
  return {
    app,
    handle,
    dir,
    ...(pipeline && coordinator && { pipeline, coordinator }),
    cleanup: async () => {
      await app.close();
      coordinator?.stop();
      try {
        handle.close();
      } catch {
        // already closed by the test
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
