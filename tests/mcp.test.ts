import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "vitest";
import { saveSecret } from "../core/src/plugin.ts";
import mcp from "../plugins/mcp/index.ts";
import { testContext } from "./support.ts";

// A notes service's MCP server that takes one token: a read, two adds and an edit.
const TOKEN = "notes-token-1";
async function notes() {
  const calls: string[] = [];
  const args: unknown[] = [];
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const server = new Server({ name: "notes", version: "1" }, { capabilities: { tools: {} } });
    const schema = { type: "object" as const, properties: { title: { type: "string" } } };
    // Like Notion's: the parent is "memory" or a page.
    const parent = { anyOf: [{ type: "string", enum: ["memory"] }, { type: "object", properties: { page_id: { type: "string" } } }] };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "search", description: "Search notes.", inputSchema: schema, annotations: { readOnlyHint: true } },
        { name: "create-page", description: "Create a note.", inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } },
        { name: "update-page", description: "Replace a note.", inputSchema: schema, annotations: { readOnlyHint: false } },
        { name: "create-pages", description: "Create notes under a parent.", inputSchema: { type: "object", properties: { parent } }, annotations: { readOnlyHint: false, destructiveHint: false } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => (calls.push(params.name), args.push(params.arguments), { content: [{ type: "text", text: `${params.name} ok` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(0, "127.0.0.1");
  await once(http, "listening");
  return { url: () => `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, calls, args, close: () => http.close() };
}

test("lists a token server's tools under its name, runs reads and adds at once, and asks before an edit", async () => {
  const service = await notes();
  const asked: string[] = [];
  const ctx = testContext({ ask: async (q) => (asked.push(q), false) });
  const { db } = ctx;
  const tools = await mcp.tools!(ctx);
  saveSecret(db, "MCP: notes", { token: TOKEN });
  db.$client.prepare("INSERT INTO mcp_servers (name, url) VALUES ('notes', ?)").run(service.url());

  const names = (await tools.list()).map((t) => t.name);
  await tools.call("notes_search", { title: "groceries" }, {});
  await tools.call("notes_create-page", { title: "groceries" }, {});
  const edit = await tools.call("notes_update-page", { title: "groceries" }, {});
  service.close();

  expect(names).toEqual(["mcp_connect", "notes_search", "notes_create-page", "notes_update-page", "notes_create-pages"]);
  expect(service.calls).toEqual(["search", "create-page"]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("update-page");
  expect(JSON.stringify(edit)).toContain("declined");
});

test("takes an argument that's a string or an object as the object in JSON", async () => {
  const service = await notes();
  const ctx = testContext({ ask: async () => false });
  const { db } = ctx;
  const tools = await mcp.tools!(ctx);
  saveSecret(db, "MCP: notes", { token: TOKEN });
  db.$client.prepare("INSERT INTO mcp_servers (name, url) VALUES ('notes', ?)").run(service.url());

  const listed = (await tools.list()).find((t) => t.name === "notes_create-pages")!;
  await tools.call("notes_create-pages", { parent: '{"page_id":"abc"}' }, {});
  await tools.call("notes_create-pages", { parent: "memory" }, {});
  service.close();

  const parentSchema = JSON.stringify(listed.inputSchema.properties!.parent);
  expect(parentSchema).toContain('{"type":"string"}');
  expect(service.args).toEqual([{ parent: { page_id: "abc" } }, { parent: "memory" }]);
});
