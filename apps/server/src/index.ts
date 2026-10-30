import { buildApp } from "./app.js";
import { config } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";

const { db, close } = openDatabase(config.DATA_DIR);
migrate(db);

const app = buildApp({ config, db });

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
