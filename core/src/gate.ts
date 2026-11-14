import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readBody } from "./http.ts";
import { input, localTools, str, text, type Caller, type Llm, type Observer, type Tools } from "./plugin.ts";

// The gate holds every key: the model at /llm, every plugin's tools at /mcp, and the owner's approvals. Saved secrets
// never reach the model provider: any in a model call becomes a placeholder.

// An answer is the whole message, so "ok wait, don't" or "yes but change it" answers nothing.
const YES = /^(yes|yep|yeah|y|ok|okay|approved?|do it|go ahead|send it)[.!]*$/i;
const NO = /^(no|nope|n|don't|do not|stop|cancel|decline)[.!]*$/i;
// Marks the gate's own questions; it and its lookalikes are stripped from the agent's texts, so the agent can't pose
// as the gate.
const LOCK = "🔐";
export const LOCKS = /[🔐🔒🔓🔏]/gu;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const MAX_QUESTION = 3000;
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

// A plugin backend's answers that send a call to LLM_BASE_URL instead: usage credits needed, rate or usage limit,
// unavailable (not logged in, not installed).
const FALLBACK_STATUSES = new Set([402, 429, 503]);
const FALLBACK_MS = Number(process.env.LLM_FALLBACK_MIN ?? 10) * 60_000;

export function createGate(opts: {
  // Any OpenAI-compatible API (AI Gateway, OpenRouter, OpenAI, a local server, …).
  // extra: fields every model call carries, for the API's own options (LLM_EXTRA, e.g. a gateway's caching or region).
  llm: { url: string; key: string; extra?: Record<string, unknown> };
  // Model names callers may use (main, task, code) -> the provider's model ids.
  models: Record<string, string>;
  send: (text: string) => Promise<void>;
  secrets?: () => { label: string; value: string }[];
}) {
  // Two sets: everything for the main agent, and the subset plugins allow task VMs. The rest is delegated: a task VM
  // can't call it, but can propose it, and the proposal goes to the main agent with the task's report.
  const sets = { main: [] as Tools[], tasks: [] as Tools[] };
  const byTool = { main: new Map<string, Tools>(), tasks: new Map<string, Tools>() };
  const proposals = new Map<number, string[]>();
  const observers: Observer[] = [];
  // Plugins' backends (Plugin.llm), by the model names they answer; upstream ones apart.
  const backends = new Map<string, Llm>();
  const upstreams = new Map<string, Llm>();
  const propose = localTools([
    {
      name: "propose",
      description: "Propose something only the main agent may do (texting the user, email, calendar, GitHub changes…): it sees the proposal with your report and decides.",
      input: input({ tool: str("The main agent's tool, from the list in this description."), args: { type: "object" }, why: str() }),
      async run({ tool, args, why }, { slot = 0 }) {
        proposals.set(slot, [...(proposals.get(slot) ?? []), `${tool} ${JSON.stringify(args)}: ${why}`]);
        return text("Proposed; the main agent decides once your report is in.");
      },
    },
  ]);

  // Questions go out one at a time, in order: a yes or a no answers the one asked.
  const queue: { question: string; resolve: (yes: boolean) => void }[] = [];
  const next = () => {
    const current = queue[0];
    if (!current) return;
    void opts.send(`${LOCK} ${current.question}\n\nReply yes or no.`);
    setTimeout(() => {
      if (queue[0] !== current) return;
      void opts.send(`${LOCK} No answer in ${ANSWER_TIMEOUT_MS / 60_000} minutes, so that's a no.`);
      settle(false);
    }, ANSWER_TIMEOUT_MS);
  };
  function settle(yes: boolean) {
    queue.shift()!.resolve(yes);
    next();
  }

  function ask(question: string) {
    return new Promise<boolean>((resolve) => {
      if (question.length > MAX_QUESTION) question = `${question.slice(0, MAX_QUESTION)} […longer than shown]`;
      queue.push({ question, resolve });
      if (queue.length === 1) next();
    });
  }

  // True when the message answered a question, so it doesn't reach the agent.
  function answer(message: string) {
    const said = message.trim();
    if (!queue.length) return false;
    const yes = YES.test(said);
    if (!yes && !NO.test(said)) return false;
    void opts.send(yes ? "Approved." : "Declined.");
    settle(yes);
    return true;
  }

  async function listTools(set: keyof typeof sets) {
    const lists = await Promise.all(sets[set].map(async (p) => ({ p, tools: await p.list() })));
    if (set === "tasks") {
      const own = new Set(lists.flatMap(({ tools }) => tools.map((t) => t.name)));
      const delegated = (await listTools("main")).map((t) => t.name).filter((n) => !own.has(n));
      const [tool] = await propose.list();
      lists.push({ p: propose, tools: [{ ...tool, description: `${tool.description} The main agent's tools: ${delegated.join(", ")}.` }] });
    }
    byTool[set] = new Map(lists.flatMap(({ p, tools }) => tools.map((t) => [t.name, p] as const)));
    return lists.flatMap(({ tools }) => tools);
  }

  // Each slot's tool calls in progress, oldest first: a task in one (e.g. waiting on the owner's yes) isn't quiet.
  const calls = new Map<number, { tool: string; since: number }[]>();

  async function callTool(set: keyof typeof sets, name: string, args: Record<string, unknown>, caller: Caller) {
    if (!byTool[set].has(name)) await listTools(set);
    const plugin = byTool[set].get(name);
    if (!plugin) throw new Error(`no tool ${name}`);
    const done = observers.map((o) => o.tool?.({ name, args, slot: caller.slot }));
    const call = { tool: name, since: Date.now() };
    if (caller.slot && !calls.has(caller.slot)) calls.set(caller.slot, []);
    const inSlot = caller.slot ? calls.get(caller.slot)! : [];
    inSlot.push(call);
    try {
      const result = await plugin.call(name, args, caller);
      const seen = done.some(Boolean) ? (scrub(result, opts.secrets?.() ?? []) as typeof result) : result;
      for (const end of done) end?.(seen);
      return result;
    } catch (err) {
      for (const end of done) end?.(undefined, err);
      throw err;
    } finally {
      inSlot.splice(inSlot.indexOf(call), 1);
    }
  }

  // The owner's messages for a slot's running task (tell_task), until its VM asks for them.
  const told = new Map<number, string[]>();
  // A task VM gets the task model, or the one its task was started with (a coding task), whatever model it names.
  const slotModels = new Map<number, string>();
  // The task each slot is running, and what it was asked, for its tool calls' `Caller`.
  const slotTasks = new Map<number, number>();
  const slotAsked = new Map<number, string>();

  // Each plugin backend's models that failed recently, until when (see FALLBACK_STATUSES).
  const benched = new Map<Llm, Map<string, number>>();
  async function llm(req: IncomingMessage, res: ServerResponse, slot?: number) {
    if (req.method !== "POST" || req.url !== "/llm/chat/completions") return void res.writeHead(404).end();
    const body = scrub(JSON.parse(await readBody(req)), opts.secrets?.() ?? []) as { model: string; tools?: unknown[] };
    const name = slot ? (slotModels.get(slot) ?? "task") : body.model;
    // The ways to answer, in order: a plugin's backend, an upstream plugin's, LLM_BASE_URL. One that failed recently
    // is skipped, unless it's the last.
    const ways: { llm?: Llm; model: string }[] = [backends.get(name), upstreams.get(name)].flatMap((b) => (b ? [{ llm: b, model: b.models[name] }] : []));
    if (opts.models[name]) ways.push({ model: opts.models[name] });
    const live = ways.filter((w, i) => i === ways.length - 1 || Date.now() >= (benched.get(w.llm!)?.get(name) ?? 0));
    if (!live.length) return void res.writeHead(400).end(`unknown model ${body.model}`);
    let way = live[0];
    const done = observers.map((o) => o.llm?.({ slot, model: way.model, request: body }));
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const call = { name, slot, task: slot ? slotTasks.get(slot) : undefined };
    const send = ({ llm: b, model }: { llm?: Llm; model: string }) =>
      b
        ? b.complete({ ...body, model, tools: body.tools?.map(strict) }, abort.signal, call).catch(() => new Response(null, { status: 503 }))
        : fetch(`${opts.llm.url.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.llm.key}` },
            body: JSON.stringify({ ...body, model, tools: body.tools?.map(strict), ...opts.llm.extra }),
          });
    let upstream = await send(way);
    // A plugin's backend that's out of usage, logged out or unavailable: the call goes the next way instead, and so
    // do this model's next calls for a while.
    for (const next of live.slice(1)) {
      if (!way.llm || !FALLBACK_STATUSES.has(upstream.status)) break;
      console.error(`model ${name}: the plugin's backend answered ${upstream.status}; using ${next.model} for ${FALLBACK_MS / 60_000} min`);
      benched.set(way.llm, (benched.get(way.llm) ?? new Map()).set(name, Date.now() + FALLBACK_MS));
      await upstream.body?.cancel().catch(() => {});
      way = next;
      upstream = await send(way);
    }
    res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of upstream.body ?? []) {
      res.write(chunk);
      if (done.some(Boolean)) chunks.push(chunk);
    }
    res.end();
    for (const end of done) end?.({ status: upstream.status, body: Buffer.concat(chunks).toString("utf8") });
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
  // `peer` may be a function, for a machine whose address is known only once it's up (nodes.ts).
  const handler = (slot?: number, peer?: string | (() => string | undefined)) => (req: IncomingMessage, res: ServerResponse) => {
    const set = slot ? "tasks" : "main";
    const allowed = typeof peer === "function" ? (peer() ?? "") : peer;
    if (allowed !== undefined && req.socket.remoteAddress?.replace(/^::ffff:/, "") !== allowed) return void res.writeHead(403).end();
    if (set === "tasks" && !TASK_HOSTS.test(req.headers.host ?? "")) return void res.writeHead(403).end();
    // A task VM asks for what the owner said since its task started, each message once.
    if (slot && req.method === "GET" && req.url === "/messages") {
      const said = told.get(slot) ?? [];
      told.delete(slot);
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(said));
    }
    (req.url?.startsWith("/llm/") ? llm(req, res, slot) : mcp(req, res, set, { slot, task: slot && slotTasks.get(slot), asked: slot ? slotAsked.get(slot) : undefined })).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(502).end(String(err));
    });
  };

  return {
    ask,
    answer,
    route: (slot: number, model?: string) => (model ? slotModels.set(slot, model) : slotModels.delete(slot)),
    // A new task in the slot (or none) starts with nothing told.
    assign(slot: number, task?: number, goal?: string) {
      told.delete(slot);
      if (task) slotTasks.set(slot, task);
      else slotTasks.delete(slot);
      if (task && goal) slotAsked.set(slot, goal);
      else slotAsked.delete(slot);
    },
    // Passes the owner's message to the slot's running task, with saved secrets scrubbed as everywhere else.
    tell(slot: number, message: string) {
      told.set(slot, [...(told.get(slot) ?? []), scrub(message, opts.secrets?.() ?? []) as string]);
      if (slotAsked.has(slot)) slotAsked.set(slot, `${slotAsked.get(slot)}\n${message}`);
    },
    // The slot's oldest tool call in progress, if any.
    busy: (slot: number) => calls.get(slot)?.[0],
    // The main agent's requests (the model, its tools), for a listener of the caller's choosing.
    handle: handler(),
    add(tools: Tools) {
      sets.main.push(tools);
      if (tools.tasks) sets.tasks.push(tools.tasks);
    },
    observe: (observer: Observer) => void observers.push(observer),
    serve: (llm: Llm) => Object.keys(llm.models).forEach((name) => (llm.upstream ? upstreams : backends).set(name, llm)),
    // What a task VM in `slot` proposed for the main agent, cleared as it's read.
    proposed(slot: number) {
      const said = proposals.get(slot) ?? [];
      proposals.delete(slot);
      return said;
    },
    listen: (host: string, port: number, opts: { slot?: number; peer?: string | (() => string | undefined) } = {}) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer(handler(opts.slot, opts.peer)).once("error", reject);
        server.listen(port, host, () => resolve(server));
      }),
  };
}
