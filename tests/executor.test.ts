import { mkdtempSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ensureExecutorToken } from "../agent/src/connectors.ts";

// The fresh Executor from tests/compose.yaml (its origin is its own URL).
const EXECUTOR_URL = "http://127.0.0.1:8095";

test("sets up a fresh Executor: the owner's admin account, the agent's token and the catalog apps", async () => {
  const tokenFile = join(mkdtempSync(join(tmpdir(), "executor-")), "token");
  const admin = { name: "Test Owner", email: `owner-${randomUUID()}@example.com`, password: randomBytes(18).toString("base64url") };

  const token = await ensureExecutorToken(EXECUTOR_URL, EXECUTOR_URL, tokenFile, admin);
  const again = await ensureExecutorToken(EXECUTOR_URL, EXECUTOR_URL, tokenFile, admin);
  expect(token).toMatch(/^exp_/);
  expect(again).toBe(token);

  // Installing fails loudly in ensureExecutorToken; an installed app's tools show up in search (GitHub's only once
  // an account is connected, so Google stands in for both).
  const gmail = await searchTools(token, "gmail send");
  expect(gmail).toContain("tools.google.");
});

// Executor's own MCP `search` tool, as the agent calls it.
async function searchTools(token: string, query: string) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const post = (body: object, session?: string) =>
    fetch(`${EXECUTOR_URL}/mcp`, { method: "POST", headers: session ? { ...headers, "Mcp-Session-Id": session } : headers, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const session = init.headers.get("mcp-session-id")!;
  const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query } } }, session);
  return await res.text();
}
