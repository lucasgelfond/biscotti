import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { boot, newDataDir } from "./support.ts";

// The fresh Executor from tests/compose.yaml. Its first-run setup works once, so the tests share one data directory
// (and the token minted into it).
process.env.OWNER_EMAIL = `owner-${Date.now()}@example.com`;
process.env.EXECUTOR_ADMIN_PASSWORD = crypto.randomUUID();
const dir = newDataDir();
const booted = boot(["connectors/executor"], dir);

async function mcp(url: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test("sets up a fresh Executor: the owner's admin account, the agent's token and the catalog apps", async () => {
  await booted;

  const token = readFileSync(`${dir}/executor-token`, "utf8");
  const again = await boot(["connectors/executor"], dir);
  const gate = await mcp(`${again.gateUrl}/mcp`);
  // An installed app's tools show up in search (GitHub's only once an account is connected).
  const found = await gate.callTool({ name: "search", arguments: { query: "gmail send" } });
  await gate.close();

  expect(token).toMatch(/^exp_/);
  expect(JSON.stringify(found)).toContain("tools.google.");
});

test("offers Executor's tools through the gate without the token or a way to approve", async () => {
  const { gateUrl } = await booted;

  const gate = await mcp(`${gateUrl}/mcp`);
  const names = (await gate.listTools()).tools.map((t) => t.name);
  const resume = gate.callTool({ name: "resume", arguments: { requestId: "apr_x", response: { action: "accept" } } });
  await expect(resume).rejects.toThrow("Approvals go to the owner");
  await gate.close();

  expect(names).toContain("search");
  expect(names).not.toContain("resume");
});
