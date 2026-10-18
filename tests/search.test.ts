import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgent } from "../agent/src/agent.ts";
import { connectors } from "../agent/src/connectors.ts";
import { openDb, transcripts } from "../agent/src/db.ts";

// Exa's hosted MCP server with the owner's key, as the main agent uses it.
const EXA_API_KEY = process.env.EXA_API_KEY;

test.skipIf(!EXA_API_KEY)("answers a question that needs the web by searching with Exa", async () => {
  const dir = mkdtempSync(join(tmpdir(), "biscotti-"));
  const db = openDb(join(dir, "biscotti.db"));
  const agent = await createAgent({ db, dir, tools: [], extensions: connectors({ exaKey: EXA_API_KEY }) });

  const reply = await agent.reply("Search the web: what's the latest Firecracker release on GitHub? Answer with just the version.");

  const toolCalls = db
    .select({ entry: transcripts.entry })
    .from(transcripts)
    .all()
    .flatMap(({ entry }) => (entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : []))
    .flatMap((c) => (c.type === "toolCall" ? [c.name] : []));
  expect(toolCalls).toContain("mcp__exa__web_search_exa");
  expect(reply).toMatch(/v?1\.\d+/);
});
