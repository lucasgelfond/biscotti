import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tools } from "./plugin.ts";

// The gate holds every key: the model at /llm, every plugin's tools at /mcp, and the owner's approvals.

export const YES = /^(yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)\b/i;
export const NO = /^(no|nope|n|don't|do not|stop|cancel|decline)\b/i;
const ANSWER_TIMEOUT_MS = 10 * 60_000;

// Some providers (Gemini) reject loose JSON Schema that MCP tools use: type lists, and properties on untyped or
// non-object nodes.
function strict(tool: unknown): unknown {
  const fix = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(fix);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fix(v)]));
    if (Array.isArray(out.type)) out.type = out.type.find((t) => t !== "null") ?? "string";
    if (out.properties && !out.type) out.type = "object";
    if (out.type && out.type !== "object") {
      delete out.properties;
      delete out.required;
    }
    return out;
  };
  return fix(tool);
}

export function createGate(opts: {
  // Any OpenAI-compatible API (AI Gateway, OpenRouter, OpenAI, a local server, …).
  llm: { url: string; key: string };
  // Model names callers may use (main, task) -> the provider's model ids.
  models: Record<string, string>;
  send: (text: string) => Promise<void>;
}) {
  const plugins: Tools[] = [];
  let byTool = new Map<string, Tools>();
  let pending: ((yes: boolean) => void) | undefined;

  // One question at a time; the owner's next yes or no answers it.
  function ask(question: string) {
    void opts.send(question);
    return new Promise<boolean>((resolve) => {
      pending?.(false);
      pending = resolve;
      setTimeout(() => {
        if (pending !== resolve) return;
        pending = undefined;
        resolve(false);
      }, ANSWER_TIMEOUT_MS);
    });
  }

  function answer(message: string) {
    const said = message.trim();
    if (!pending || !(YES.test(said) || NO.test(said))) return false;
    const yes = YES.test(said);
    pending(yes);
    pending = undefined;
    void opts.send(yes ? "Approved." : "Declined.");
    return true;
  }

  async function listTools() {
    const lists = await Promise.all(plugins.map(async (p) => ({ p, tools: await p.list() })));
    byTool = new Map(lists.flatMap(({ p, tools }) => tools.map((t) => [t.name, p] as const)));
    return lists.flatMap(({ tools }) => tools);
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    if (!byTool.has(name)) await listTools();
    const plugin = byTool.get(name);
    if (!plugin) throw new Error(`no tool ${name}`);
    return plugin.call(name, args);
  }

  async function llm(req: IncomingMessage, res: ServerResponse) {
    const body = JSON.parse(await readBody(req));
    const model = opts.models[body.model];
    if (!model) return void res.writeHead(400).end(`unknown model ${body.model}`);
    const upstream = await fetch(`${opts.llm.url.replace(/\/$/, "")}${req.url!.slice("/llm".length)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.llm.key}` },
      body: JSON.stringify({ ...body, model, tools: body.tools?.map(strict) }),
    });
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
    for await (const chunk of upstream.body ?? []) res.write(chunk);
    res.end();
  }

  async function mcp(req: IncomingMessage, res: ServerResponse) {
    const server = new McpServer({ name: "biscotti", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => callTool(params.name, params.arguments ?? {}));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  const handler = (req: IncomingMessage, res: ServerResponse) =>
    (req.url?.startsWith("/llm/") ? llm(req, res) : mcp(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(502).end(String(err));
    });

  return {
    ask,
    answer,
    add: (tools: Tools) => plugins.push(tools),
    listen: (host: string, port: number) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer(handler).once("error", reject);
        server.listen(port, host, () => resolve(server));
      }),
  };
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
