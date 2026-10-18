import { defineTool, type FileEntry } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3-multiple-ciphers";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Type } from "typebox";
import type { Recall } from "./plugin.ts";
import { memories, transcripts } from "./schema.ts";

// Keyword search (FTS5) over transcripts and saved facts; Recall plugins' rankings are fused in by reciprocal rank.

// Encrypted at rest with `key` (SQLite3 Multiple Ciphers). A database from before encryption is encrypted in place.
export function openDb(path: string, key: string) {
  let sqlite = new Database(path);
  sqlite.pragma(`key='${key}'`);
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    sqlite.close();
    sqlite = new Database(path);
    sqlite.pragma(`rekey='${key}'`);
  }
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  return db;
}

export type Db = ReturnType<typeof openDb>;

export function searchableText(entry: FileEntry): string | null {
  if (entry.type !== "message") return null;
  const { role, content } = entry.message as { role: string; content: unknown };
  if (role !== "user" && role !== "assistant") return null;
  const parts = typeof content === "string" ? [content] : (content as { text?: string }[]).map((p) => p.text ?? "");
  const joined = parts.join("\n").trim();
  return joined ? `${role}: ${joined}` : null;
}

// Quoted terms, so user text is never parsed as FTS5 syntax.
const ftsQuery = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => `"${t}"`).join(" OR ");

const reply = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

const RRF_K = 60;
const LIMIT = 5;

export function memoryTools(db: Db, recalls: Recall[]) {
  const remember = defineTool({
    name: "remember",
    label: "Remember",
    description: "Save one durable fact about the user (a preference, plan, person, detail) for future conversations.",
    parameters: Type.Object({ fact: Type.String({ description: "One self-contained fact, e.g. 'Lucas parks on level 3, aisle G'." }) }),
    async execute(_id, { fact }) {
      const [row] = db.insert(memories).values({ content: fact }).returning({ id: memories.id }).all();
      await Promise.all(recalls.map((r) => r.index(row.id, fact)));
      return reply(`saved memory ${row.id}`);
    },
  });

  const recall = defineTool({
    name: "recall",
    label: "Recall",
    description: "Search saved facts about the user. Use before answering anything about the user's life, plans or preferences.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, { query }) {
      const match = ftsQuery(query);
      const keyword = match
        ? db.all<{ id: number }>(sql`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ${match} ORDER BY rank LIMIT 20`).map((r) => r.id)
        : [];
      const rankings = [keyword, ...(await Promise.all(recalls.map((r) => r.search(query))))];
      const scores = new Map<number, number>();
      for (const ranking of rankings) ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
      const ids = [...scores].sort((a, b) => b[1] - a[1]).slice(0, LIMIT).map(([id]) => id);
      if (!ids.length) return reply("no saved memories match");
      const rows = new Map(db.select().from(memories).where(inArray(memories.id, ids)).all().map((m) => [m.id, m]));
      return reply(ids.map((id) => rows.get(id)!).map((m) => `[${m.id}] ${m.createdAt.toISOString().slice(0, 10)}: ${m.content}`).join("\n"));
    },
  });

  const forget = defineTool({
    name: "forget",
    label: "Forget",
    description: "Delete a saved memory by id (from recall), e.g. when the user corrects or retracts it.",
    parameters: Type.Object({ id: Type.Integer() }),
    async execute(_id, { id }) {
      const deleted = db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id }).all();
      return reply(deleted.length ? `forgot memory ${id}` : `no memory ${id}`);
    },
  });

  const searchTranscript = defineTool({
    name: "search_transcript",
    label: "Search transcript",
    description: "Keyword search over the full history of this conversation, including parts summarized away. Use for 'what did I say about…'.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, { query }) {
      const match = ftsQuery(query);
      const rows = match
        ? db.all<{ text: string; at: string }>(sql`
            SELECT t.text, json_extract(t.entry, '$.timestamp') AS at
            FROM transcripts_fts f JOIN transcripts t ON t.seq = f.rowid
            WHERE transcripts_fts MATCH ${match} ORDER BY rank LIMIT ${LIMIT}`)
        : [];
      if (!rows.length) return reply("nothing in the transcript matches");
      return reply(rows.map((r) => `${r.at.slice(0, 16)} ${r.text}`).join("\n\n"));
    },
  });

  return [remember, recall, forget, searchTranscript];
}
