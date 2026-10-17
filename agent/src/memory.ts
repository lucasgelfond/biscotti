import { defineTool, type FileEntry } from "@earendil-works/pi-coding-agent";
import { eq, sql } from "drizzle-orm";
import { Type } from "typebox";
import { memories, type Db } from "./db.ts";

const RRF_K = 60;
const LIMIT = 5;

async function embed(url: string, input: string): Promise<Float32Array> {
  const res = await fetch(`${url}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`embeddings: ${res.status} ${await res.text()}`);
  const { data } = (await res.json()) as { data: { embedding: number[] }[] };
  return Float32Array.from(data[0].embedding);
}

// bge-small embeddings are normalized, so the dot product is the cosine similarity.
function dot(a: Float32Array, b: Float32Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// Each word as a quoted FTS5 term, OR-ed, so user text can never be parsed as query syntax.
function ftsQuery(text: string) {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => `"${t}"`).join(" OR ");
}

// A message entry's plain text, for transcripts_fts; null for entries that aren't messages.
export function searchableText(entry: FileEntry): string | null {
  if (entry.type !== "message") return null;
  const { role, content } = entry.message as { role: string; content: unknown };
  if (role !== "user" && role !== "assistant") return null;
  const parts = typeof content === "string" ? [content] : (content as { type: string; text?: string }[]).map((p) => p.text ?? "");
  const text = parts.join("\n").trim();
  return text ? `${role}: ${text}` : null;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export function memoryTools(db: Db, embeddingsUrl: string) {
  const remember = defineTool({
    name: "remember",
    label: "Remember",
    description: "Save one durable fact about the user (a preference, plan, person, detail) for future conversations.",
    parameters: Type.Object({ fact: Type.String({ description: "One self-contained fact, e.g. 'Lucas parks on level 3, aisle G'." }) }),
    async execute(_id, { fact }) {
      const vector = await embed(embeddingsUrl, fact);
      const [row] = db
        .insert(memories)
        .values({ content: fact, embedding: Buffer.from(vector.buffer) })
        .returning({ id: memories.id })
        .all();
      return text(`saved memory ${row.id}`);
    },
  });

  // Keyword (FTS5 bm25) and vector rankings fused by reciprocal rank.
  const recall = defineTool({
    name: "recall",
    label: "Recall",
    description: "Search saved facts about the user. Use before answering anything about the user's life, plans or preferences.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, { query }) {
      const match = ftsQuery(query);
      const keyword = match
        ? db.all<{ id: number }>(sql`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ${match} ORDER BY rank LIMIT 20`)
        : [];
      const vector = await embed(embeddingsUrl, query);
      const all = db.select().from(memories).all();
      const semantic = all
        .map((m) => ({ id: m.id, score: dot(vector, new Float32Array(new Uint8Array(m.embedding).buffer)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      const scores = new Map<number, number>();
      for (const ranking of [keyword, semantic])
        ranking.forEach(({ id }, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
      const byId = new Map(all.map((m) => [m.id, m]));
      const hits = [...scores].sort((a, b) => b[1] - a[1]).slice(0, LIMIT).map(([id]) => byId.get(id)!);
      if (!hits.length) return text("no saved memories match");
      return text(hits.map((m) => `[${m.id}] ${m.createdAt.toISOString().slice(0, 10)}: ${m.content}`).join("\n"));
    },
  });

  const forget = defineTool({
    name: "forget",
    label: "Forget",
    description: "Delete a saved memory by id (from recall), e.g. when the user corrects or retracts it.",
    parameters: Type.Object({ id: Type.Integer() }),
    async execute(_id, { id }) {
      const deleted = db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id }).all();
      return text(deleted.length ? `forgot memory ${id}` : `no memory ${id}`);
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
      if (!rows.length) return text("nothing in the transcript matches");
      return text(rows.map((r) => `${r.at.slice(0, 16)} ${r.text}`).join("\n\n"));
    },
  });

  return [remember, recall, forget, searchTranscript];
}
