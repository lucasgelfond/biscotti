import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tools } from "./plugin.ts";

// The gate holds every key: the model at /llm, every plugin's tools at /mcp, and the owner's approvals.

// An answer is the whole message, so "ok wait, don't" or "yes but change it" answers nothing.
export const YES = /^(yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)[.!]*$/i;
export const NO = /^(no|nope|n|don't|do not|stop|cancel|decline)[.!]*$/i;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const TASK_HOSTS = /^(gate|127\.0\.0\.1|172\.16\.0\.1|10\.200\.\d+\.1)(:\d+)?$/;

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
  // Two sets: everything for the main agent, and the subset plugins allow task VMs.
  const sets = { main: [] as Tools[], tasks: [] as Tools[] };
  const byTool = { main: new Map<string, Tools>(), tasks: new Map<string, Tools>() };

  // Questions go out one at a time, in order; the owner's next yes or no answers the one on screen.
  const queue: { question: string; resolve: (yes: boolean) => void }[] = [];
  const next = () => {
    const current = queue[0];
    if (!current) return;
    void opts.send(current.question);
    setTimeout(() => queue[0] === current && settle(false), ANSWER_TIMEOUT_MS);
  };
  function settle(yes: boolean) {
    queue.shift()!.resolve(yes);
    next();
  }

  function ask(question: string) {
    return new Promise<boolean>((resolve) => {
      queue.push({ question, resolve });
      if (queue.length === 1) next();
    });
  }

  function answer(message: string) {
    const said = message.trim();
    if (!queue.length || !(YES.test(said) || NO.test(said))) return false;
    const yes = YES.test(said);
    void opts.send(yes ? "Approved." : "Declined.");
    settle(yes);
    return true;
  }

  async function listTools(set: keyof typeof sets) {
    const lists = await Promise.all(sets[set].map(async (p) => ({ p, tools: await p.list() })));
    byTool[set] = new Map(lists.flatMap(({ p, tools }) => tools.map((t) => [t.name, p] as const)));
    return lists.flatMap(({ tools }) => tools);
  }

  async function callTool(set: keyof typeof sets, name: string, args: Record<string, unknown>) {
    if (!byTool[set].has(name)) await listTools(set);
    const plugin = byTool[set].get(name);
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

  async function mcp(req: IncomingMessage, res: ServerResponse, set: keyof typeof sets) {
    const server = new McpServer({ name: "biscotti", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(set) }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => callTool(set, params.name, params.arguments ?? {}));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  // Task VMs' listeners get the task set, and only requests addressed to the gate (no DNS rebinding from a page).
  const handler = (set: keyof typeof sets) => (req: IncomingMessage, res: ServerResponse) => {
    if (set === "tasks" && !TASK_HOSTS.test(req.headers.host ?? "")) return void res.writeHead(403).end();
    (req.url?.startsWith("/llm/") ? llm(req, res) : mcp(req, res, set)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(502).end(String(err));
    });
  };

  return {
    ask,
    answer,
    add(tools: Tools) {
      sets.main.push(tools);
      if (tools.tasks) sets.tasks.push(tools.tasks);
    },
    listen: (host: string, port: number, opts: { tasks?: boolean } = {}) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer(handler(opts.tasks ? "tasks" : "main")).once("error", reject);
        server.listen(port, host, () => resolve(server));
      }),
  };
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
