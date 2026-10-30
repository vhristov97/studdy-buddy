import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Placeholder table; real tables arrive in later tasks. */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
