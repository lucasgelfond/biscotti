import type { FileEntry } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3-multiple-ciphers";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { input, int, localTools, str, text, type Recall, type Tools } from "./plugin.ts";
import { memories, transcripts } from "./schema.ts";

// Keyword search (FTS5) over transcripts and saved facts; Recall plugins' rankings are fused in by reciprocal rank.

// Encrypted at rest with `key` (SQLite3 Multiple Ciphers).
export function openDb(path: string, key: string) {
  const sqlite = new Database(path);
  sqlite.pragma(`key='${key}'`);
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

const RRF_K = 60;
const LIMIT = 5;


export function memoryTools(db: Db, recalls: Recall[]): Tools {
  return localTools([
    {
      name: "remember",
      description: "Save one durable fact about the user (a preference, plan, person, detail) for future conversations.",
      input: input({ fact: str("One self-contained fact, e.g. 'Lucas parks on level 3, aisle G'.") }),
      async run(args) {
        const fact = String(args.fact);
        const [row] = db.insert(memories).values({ content: fact }).returning({ id: memories.id }).all();
        await Promise.all(recalls.map((r) => r.index(row.id, fact)));
        return text(`saved memory ${row.id}`);
      },
    },
    {
      name: "recall",
      description: "Search saved facts about the user. Use before answering anything about the user's life, plans or preferences.",
      input: input({ query: str() }),
      async run(args) {
        const query = String(args.query);
        const match = ftsQuery(query);
        const keyword = match
          ? db.all<{ id: number }>(sql`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ${match} ORDER BY rank LIMIT 20`).map((r) => r.id)
          : [];
        const rankings = [keyword, ...(await Promise.all(recalls.map((r) => r.search(query))))];
        const scores = new Map<number, number>();
        for (const ranking of rankings) ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
        const ids = [...scores].sort((a, b) => b[1] - a[1]).slice(0, LIMIT).map(([id]) => id);
        if (!ids.length) return text("no saved memories match");
        const rows = new Map(db.select().from(memories).where(inArray(memories.id, ids)).all().map((m) => [m.id, m]));
        return text(ids.map((id) => rows.get(id)!).map((m) => `[${m.id}] ${m.createdAt.toISOString().slice(0, 10)}: ${m.content}`).join("\n"));
      },
    },
    {
      name: "forget",
      description: "Delete a saved memory by id (from recall), e.g. when the user corrects or retracts it.",
      input: input({ id: int() }),
      async run(args) {
        const id = Number(args.id);
        const deleted = db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id }).all();
        return text(deleted.length ? `forgot memory ${id}` : `no memory ${id}`);
      },
    },
    {
      name: "search_transcript",
      description: "Keyword search over the full history of this conversation, including parts summarized away. Use for 'what did I say about…'.",
      input: input({ query: str() }),
      async run(args) {
        const match = ftsQuery(String(args.query));
        const rows = match
          ? db.all<{ text: string; at: string }>(sql`
              SELECT t.text, json_extract(t.entry, '$.timestamp') AS at
              FROM transcripts_fts f JOIN transcripts t ON t.seq = f.rowid
              WHERE transcripts_fts MATCH ${match} ORDER BY rank LIMIT ${LIMIT}`)
          : [];
        if (!rows.length) return text("nothing in the transcript matches");
        return text(rows.map((r) => `${r.at.slice(0, 16)} ${r.text}`).join("\n\n"));
      },
    },
  ]);
}
