import { mkdtempSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { ensureExecutorToken } from "../agent/src/connectors.ts";
import { startPassThrough } from "../agent/src/passthrough.ts";

// The fresh Executor from tests/compose.yaml (its origin is its own URL). Its first-run setup works once, so the
// tests in this file share it.
const EXECUTOR_URL = "http://127.0.0.1:8095";
const PASSTHROUGH_PORT = 8096;
const tokenFile = join(mkdtempSync(join(tmpdir(), "executor-")), "token");
const admin = { name: "Test Owner", email: `owner-${randomUUID()}@example.com`, password: randomBytes(18).toString("base64url") };
const setup = ensureExecutorToken(EXECUTOR_URL, EXECUTOR_URL, tokenFile, admin);

async function mcp(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

test("sets up a fresh Executor: the owner's admin account, the agent's token and the catalog apps", async () => {
  const token = await setup;
  const again = await ensureExecutorToken(EXECUTOR_URL, EXECUTOR_URL, tokenFile, admin);
  expect(token).toMatch(/^exp_/);
  expect(again).toBe(token);

  // Installing fails loudly in ensureExecutorToken; an installed app's tools show up in search (GitHub's only once
  // an account is connected, so Google stands in for both).
  const executor = await mcp(`${EXECUTOR_URL}/mcp`, { Authorization: `Bearer ${token}` });
  const found = await executor.callTool({ name: "search", arguments: { query: "gmail send" } });
  await executor.close();
  expect(JSON.stringify(found)).toContain("tools.google.");
});

test("gives task VMs Executor's tools without the token or a way to approve", async () => {
  const token = await setup;
  const server = startPassThrough({ executorUrl: EXECUTOR_URL, token, port: PASSTHROUGH_PORT, askOwner: async () => false });

  const vm = await mcp(`http://127.0.0.1:${PASSTHROUGH_PORT}/mcp`);
  const names = (await vm.listTools()).tools.map((t) => t.name);
  const found = await vm.callTool({ name: "search", arguments: { query: "gmail send" } });
  const resume = vm.callTool({ name: "resume", arguments: { requestId: "apr_x", response: { action: "accept" } } });
  await expect(resume).rejects.toThrow("Approvals go to the owner");
  await vm.close();
  server.close();

  expect(names).toContain("search");
  expect(names).not.toContain("resume");
  expect(JSON.stringify(found)).toContain("tools.google.");
});
