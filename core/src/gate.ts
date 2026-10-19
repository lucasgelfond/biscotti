import { randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Caller, Tools } from "./plugin.ts";

// The gate holds every key: the model at /llm, every plugin's tools at /mcp, and the owner's approvals. Saved secrets
// never reach the model provider: any in a model call becomes a placeholder.

// An answer is the whole message, so "ok wait, don't" or "yes but change it" answers nothing. A yes names the
// question's code, so a "yes" meant for someone else, or for a question not yet seen, approves nothing.
export const YES = /^(?:yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)[.!,]*\s*#?(\d{3})[.!]*$/i;
const BARE_YES = /^(yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)[.!]*$/i;
export const NO = /^(?:no|nope|n|don't|do not|stop|cancel|decline)[.!,]*\s*#?(\d{3})?[.!]*$/i;
// Marks the gate's own questions; it and its lookalikes are stripped from the agent's texts, so the agent can't pose
// as the gate.
export const LOCK = "🔐";
export const LOCKS = /[🔐🔒🔓🔏]/gu;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const TASK_HOSTS = /^(gate|127\.0\.0\.1|172\.16\.0\.1|10\.200\.\d+\.1)(:\d+)?$/;
// Model calls carry screenshots, so they're large, but not unbounded.
const MAX_BODY = 32 * 1024 * 1024;

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

// Every string in a model call, with each secret replaced by `[vault:<entry>.<field>]`. Card numbers match with or
// without spaces and dashes.
export function scrub(node: unknown, secrets: { label: string; value: string }[]): unknown {
  const patterns = secrets.map(({ label, value }) => {
    const source = /^\d{12,19}$/.test(value) ? value.split("").join("[ -]?") : value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [new RegExp(source, "g"), `[vault:${label}]`] as const;
  });
  const walk = (n: unknown): unknown => {
    if (typeof n === "string") return patterns.reduce((s, [re, to]) => s.replace(re, () => to), n);
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === "object") return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    return n;
  };
  return walk(node);
}

export function createGate(opts: {
  // Any OpenAI-compatible API (AI Gateway, OpenRouter, OpenAI, a local server, …).
  llm: { url: string; key: string };
  // Model names callers may use (main, task) -> the provider's model ids.
  models: Record<string, string>;
  send: (text: string) => Promise<void>;
  secrets?: () => { label: string; value: string }[];
}) {
  // Two sets: everything for the main agent, and the subset plugins allow task VMs.
  const sets = { main: [] as Tools[], tasks: [] as Tools[] };
  const byTool = { main: new Map<string, Tools>(), tasks: new Map<string, Tools>() };

  // Questions go out one at a time, in order, each with a code: "yes <code>" approves that one, "no" declines it.
  const queue: { question: string; code: string; resolve: (yes: boolean) => void }[] = [];
  const next = () => {
    const current = queue[0];
    if (!current) return;
    void opts.send(`${LOCK} ${current.question}\n\nReply "yes ${current.code}" to approve, or "no".`);
    setTimeout(() => {
      if (queue[0] !== current) return;
      void opts.send(`${LOCK} No answer in ${ANSWER_TIMEOUT_MS / 60_000} minutes, so that's a no (${current.code}).`);
      settle(false);
    }, ANSWER_TIMEOUT_MS);
  };
  function settle(yes: boolean) {
    queue.shift()!.resolve(yes);
    next();
  }

  let lastCode = "";
  function ask(question: string) {
    let code: string;
    do code = String(randomInt(100, 1000));
    while (code === lastCode || queue.some((q) => q.code === code));
    lastCode = code;
    return new Promise<boolean>((resolve) => {
      queue.push({ question, code, resolve });
      if (queue.length === 1) next();
    });
  }

  // True when the message was meant for the gate (an answer, or a yes it can't take), so it doesn't reach the agent.
  function answer(message: string) {
    const said = message.trim();
    const current = queue[0];
    const code = (YES.exec(said) ?? NO.exec(said))?.[1];
    const tell = (text: string) => (void opts.send(`${LOCK} ${text}`), true);
    if (code && code !== current?.code) return tell(`Nothing is waiting on ${code}, so that answers nothing.`);
    if (!current) return false;
    if (BARE_YES.test(said)) return tell(`To approve, reply "yes ${current.code}".`);
    const yes = YES.test(said);
    if (!yes && !NO.test(said)) return false;
    void opts.send(yes ? "Approved." : "Declined.");
    settle(yes);
    return true;
  }

  async function listTools(set: keyof typeof sets) {
    const lists = await Promise.all(sets[set].map(async (p) => ({ p, tools: await p.list() })));
    byTool[set] = new Map(lists.flatMap(({ p, tools }) => tools.map((t) => [t.name, p] as const)));
    return lists.flatMap(({ tools }) => tools);
  }

  async function callTool(set: keyof typeof sets, name: string, args: Record<string, unknown>, caller: Caller) {
    if (!byTool[set].has(name)) await listTools(set);
    const plugin = byTool[set].get(name);
    if (!plugin) throw new Error(`no tool ${name}`);
    return plugin.call(name, args, caller);
  }

  // A task VM gets the task model, or the one its task was started with (a coding task), whatever model it names.
  const slotModels = new Map<number, string>();

  async function llm(req: IncomingMessage, res: ServerResponse, slot?: number) {
    if (req.method !== "POST" || req.url !== "/llm/chat/completions") return void res.writeHead(404).end();
    const body = scrub(JSON.parse(await readBody(req)), opts.secrets?.() ?? []) as { model: string; tools?: unknown[] };
    const model = opts.models[slot ? (slotModels.get(slot) ?? "task") : body.model];
    if (!model) return void res.writeHead(400).end(`unknown model ${body.model}`);
    const upstream = await fetch(`${opts.llm.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.llm.key}` },
      body: JSON.stringify({ ...body, model, tools: body.tools?.map(strict) }),
    });
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
    for await (const chunk of upstream.body ?? []) res.write(chunk);
    res.end();
  }

  async function mcp(req: IncomingMessage, res: ServerResponse, set: keyof typeof sets, caller: Caller) {
    const server = new McpServer({ name: "biscotti", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(set) }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => callTool(set, params.name, params.arguments ?? {}, caller));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  // A task VM slot's listener gets the task set, only from that slot's VM (`peer`), and only requests addressed to the
  // gate (no DNS rebinding from a page).
  const handler = (slot?: number, peer?: string) => (req: IncomingMessage, res: ServerResponse) => {
    const set = slot ? "tasks" : "main";
    if (peer && req.socket.remoteAddress?.replace(/^::ffff:/, "") !== peer) return void res.writeHead(403).end();
    if (set === "tasks" && !TASK_HOSTS.test(req.headers.host ?? "")) return void res.writeHead(403).end();
    (req.url?.startsWith("/llm/") ? llm(req, res, slot) : mcp(req, res, set, { slot })).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(502).end(String(err));
    });
  };

  return {
    ask,
    answer,
    route: (slot: number, model?: string) => (model ? slotModels.set(slot, model) : slotModels.delete(slot)),
    // The main agent's requests (the model, its tools), for a listener of the caller's choosing.
    handle: handler(),
    add(tools: Tools) {
      sets.main.push(tools);
      if (tools.tasks) sets.tasks.push(tools.tasks);
    },
    listen: (host: string, port: number, opts: { slot?: number; peer?: string } = {}) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer(handler(opts.slot, opts.peer)).once("error", reject);
        server.listen(port, host, () => resolve(server));
      }),
  };
}

export async function readBody(req: AsyncIterable<unknown>, max = MAX_BODY) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error(`request over ${max / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
