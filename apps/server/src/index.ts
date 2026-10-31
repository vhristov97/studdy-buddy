import { buildApp } from "./app.js";
import { initAgentRuntime } from "./agents/runtime.js";
import { config } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";

const { db, close } = openDatabase(config.DATA_DIR);
migrate(db);

const app = buildApp({ config, db });

try {
  initAgentRuntime({ logger: app.log });
} catch (err) {
  app.log.error(err);
  close();
  process.exit(1);
}

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
    close();
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error(err);
  close();
  process.exit(1);
}
