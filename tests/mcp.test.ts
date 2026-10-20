import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";
import { openDb } from "../core/src/memory.ts";
import { saveSecret } from "../core/src/plugin.ts";
import mcp from "../plugins/mcp/index.ts";
import { newDataDir } from "./support.ts";

// A notes service's MCP server that takes one token: a read, an add and an edit.
const TOKEN = "notes-token-1";
function notes() {
  const calls: string[] = [];
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const server = new Server({ name: "notes", version: "1" }, { capabilities: { tools: {} } });
    const schema = { type: "object" as const, properties: { title: { type: "string" } } };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "search", description: "Search notes.", inputSchema: schema, annotations: { readOnlyHint: true } },
        { name: "create-page", description: "Create a note.", inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } },
        { name: "update-page", description: "Replace a note.", inputSchema: schema, annotations: { readOnlyHint: false } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => (calls.push(params.name), { content: [{ type: "text", text: `${params.name} ok` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(0, "127.0.0.1");
  return { url: () => `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, calls, close: () => http.close() };
}

test("lists a token server's tools under its name, runs reads and adds at once, and asks before an edit", async () => {
  const service = notes();
  await new Promise((r) => setTimeout(r, 50));
  const dir = newDataDir();
  const db = openDb(`${dir}/biscotti.db`, "k");
  const asked: string[] = [];
  const ctx = { db, dir, env: (n: string) => n, ask: async (q: string) => (asked.push(q), false), deliver: async () => {}, send: async () => {} };
  const tools = await mcp.tools!(ctx);
  saveSecret(db, "MCP: notes", { token: TOKEN });
  db.$client.prepare("INSERT INTO mcp_servers (name, url) VALUES ('notes', ?)").run(service.url());

  const names = (await tools.list()).map((t) => t.name);
  await tools.call("notes_search", { title: "groceries" }, {});
  await tools.call("notes_create-page", { title: "groceries" }, {});
  const edit = await tools.call("notes_update-page", { title: "groceries" }, {});
  service.close();

  expect(names).toEqual(["mcp_connect", "notes_search", "notes_create-page", "notes_update-page"]);
  expect(service.calls).toEqual(["search", "create-page"]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("update-page");
  expect(JSON.stringify(edit)).toContain("declined");
});
