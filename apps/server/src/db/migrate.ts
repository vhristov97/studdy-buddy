import { config } from "../config.js";
import { migrate, openDatabase } from "./client.js";

const { db, close } = openDatabase(config.DATA_DIR);
try {
  migrate(db);
  console.log(`Migrations applied to ${config.DATA_DIR}/app.sqlite`);
} finally {
  close();
}
