import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

// Every pi session entry, in order, including those compaction has summarized away.
// `text` holds a message's searchable text (indexed by transcripts_fts); it is null for other entries.
export const transcripts = sqliteTable("transcripts", {
  seq: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  entry: text({ mode: "json" }).$type<FileEntry>().notNull(),
  text: text(),
});

// Durable facts the agent saves (indexed by memories_fts); `embedding` is 384 float32s from bge-small.
export const memories = sqliteTable("memories", {
  id: integer().primaryKey({ autoIncrement: true }),
  content: text().notNull(),
  embedding: blob({ mode: "buffer" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Scheduled wakes: a prompt the agent gave itself, due on a cron schedule or once at a set time (`when`).
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

export function openDb(path: string) {
  const db = drizzle(new Database(path));
  migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  return db;
}

export type Db = ReturnType<typeof openDb>;
