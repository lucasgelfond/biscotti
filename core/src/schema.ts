import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Every pi session entry, in order, including those compaction has summarized away. `text` is a message's
// searchable text (indexed by transcripts_fts), null for other entries.
export const transcripts = sqliteTable("transcripts", {
  seq: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  entry: text({ mode: "json" }).$type<FileEntry>().notNull(),
  text: text(),
});

// Durable facts the agent saves (indexed by memories_fts).
export const memories = sqliteTable("memories", {
  id: integer().primaryKey({ autoIncrement: true }),
  content: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
