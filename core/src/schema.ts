import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Every pi session entry, including ones compaction summarized away.
export const transcripts = sqliteTable("transcripts", {
  seq: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  entry: text({ mode: "json" }).$type<FileEntry>().notNull(),
  text: text(),
});

// Prompts the agent schedules for itself (crons.ts).
export const wakes = sqliteTable("wakes", {
  id: integer().primaryKey({ autoIncrement: true }),
  label: text().notNull(),
  when: text().notNull(),
  prompt: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastRun: integer("last_run", { mode: "timestamp" }),
});

// Logins, cards and licenses (vault.ts): field names, whether each use asks the owner, and the values.
export const vault = sqliteTable("vault", {
  name: text().primaryKey(),
  fields: text({ mode: "json" }).$type<string[]>().notNull(),
  confirm: integer({ mode: "boolean" }).notNull(),
  value: text({ mode: "json" }).$type<Record<string, string>>().notNull(),
});

export const memories = sqliteTable("memories", {
  id: integer().primaryKey({ autoIncrement: true }),
  content: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
