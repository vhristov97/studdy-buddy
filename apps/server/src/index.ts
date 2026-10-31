import { buildApp } from "./app.js";
import { Coordinator } from "./agents/coordinator.js";
import { initAgentRuntime } from "./agents/runtime.js";
import { config } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";
import { createPipeline } from "./pipeline/pipeline.js";

const { db, close } = openDatabase(config.DATA_DIR);
migrate(db);

// The agent runtime and coordinator must exist before the app, and both log through it.
const log = {
  warn: (obj: object, msg: string) => app.log.warn(obj, msg),
  error: (obj: object, msg: string) => app.log.error(obj, msg),
  debug: (obj: object, msg: string) => app.log.debug(obj, msg),
};

try {
  initAgentRuntime({ logger: log });
} catch (err) {
  console.error(err);
  close();
  process.exit(1);
}

const coordinator = new Coordinator({ logger: log });
coordinator.start();
const pipeline = createPipeline({ db, coordinator, logger: log });
pipeline.recoverInterruptedJobs();

const app = buildApp({ config, db, pipeline, coordinator });

// Safety net only: ResilientRunner turns inference failures into `stage.failed`, so a stray
// rejection is a bug to log, not a reason to take the server down.
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandled promise rejection");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } finally {
    coordinator.stop();
    close();
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  // Host only: the base URL may carry a path or credentials we must not log.
  app.log.info(
    { anthropicHost: new URL(config.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").host },
    "Anthropic endpoint",
  );
} catch (err) {
  app.log.error(err);
  close();
  process.exit(1);
}
