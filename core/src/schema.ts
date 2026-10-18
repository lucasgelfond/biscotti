import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Every pi session entry, including ones compaction summarized away.
export const transcripts = sqliteTable("transcripts", {
  seq: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  entry: text({ mode: "json" }).$type<FileEntry>().notNull(),
  text: text(),
});

export const memories = sqliteTable("memories", {
  id: integer().primaryKey({ autoIncrement: true }),
  content: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
