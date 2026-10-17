import { pgTable, serial, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

// One row holding the whole academy dataset (entries, swimmers, results, payments, ...)
export const appState = pgTable("app_state", {
  key: text().primaryKey(),
  data: jsonb().notNull(),
  version: integer().notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Every add / edit / delete made on the site
export const changeLog = pgTable("change_log", {
  id: serial().primaryKey(),
  area: text().notNull(),
  action: text().notNull(),
  summary: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
