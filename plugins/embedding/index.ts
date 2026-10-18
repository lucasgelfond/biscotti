import { type Plugin } from "@biscotti/core";
import { sql } from "drizzle-orm";

// Recall by meaning: bge-small embeddings from llama.cpp (compose.yaml).

const BASE = process.env.EMBEDDINGS_URL ?? "http://127.0.0.1:8090";
const LIMIT = 20;

async function embed(input: string): Promise<Float32Array> {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`embeddings: ${res.status} ${await res.text()}`);
  const { data } = (await res.json()) as { data: { embedding: number[] }[] };
  return Float32Array.from(data[0].embedding);
}

// Normalized, so the dot product is cosine similarity.
function dot(a: Float32Array, b: Float32Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export default {
  async recall({ db }) {
    db.run(sql`CREATE TABLE IF NOT EXISTS memory_vectors (memory_id integer PRIMARY KEY NOT NULL, vector blob NOT NULL)`);
    const index = async (id: number, text: string) => {
      const vector = await embed(text);
      db.run(sql`INSERT OR REPLACE INTO memory_vectors VALUES (${id}, ${Buffer.from(vector.buffer)})`);
    };
    // Memories saved while this plugin was off.
    const missing = db.all<{ id: number; content: string }>(
      sql`SELECT id, content FROM memories WHERE id NOT IN (SELECT memory_id FROM memory_vectors)`,
    );
    for (const m of missing) await index(m.id, m.content);

    return {
      index,
      async search(query) {
        const q = await embed(query);
        return db
          .all<{ id: number; vector: Buffer }>(sql`SELECT v.memory_id AS id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id`)
          .map((r) => ({ id: r.id, score: dot(q, new Float32Array(new Uint8Array(r.vector).buffer)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, LIMIT)
          .map((r) => r.id);
      },
    };
  },
} satisfies Plugin;
