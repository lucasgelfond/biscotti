import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { BACKGROUND_CONTEXT, type Context as RunContext } from "@earendil-works/chord/context";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { contentText } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type ConversationId, createRegistry, defineExtension, defineTool, type Extension, Harness, LiveDoc, section, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import { type Chat, durableAhp, type Entry, inputFrom } from "pi-durable-ahp";
import { createMessageConnection, type MessageConnection, SocketMessageReader, SocketMessageWriter } from "vscode-jsonrpc/node.js";
import { answer, listen } from "./http.ts";
import { openEncrypted } from "./memory.ts";

// The main agent: pi-durable runs every conversation, each turn and tool call committed before it shows, so a run a
// crash or restart cut off picks up where it was. It holds no key of the gate's and has no network: its model and
// biscotti's tools come through the gate's socket, and everything else over its link to the gate (connect.ts), which
// it opens and starts with a hello. Its own storage is its own database, under a key of its own. Sessions: "main"
// (the owner's texts) and the others by the id an app gave them; the owner's apps see and drive them over the Agent
// Host Protocol (/ahp on its socket). Plugins may have a side here too (Plugin.agent): the tasks plugin's runs tasks.

const ctx = BACKGROUND_CONTEXT;
const MAIN_MODEL = { provider: "biscotti", modelId: "main" } as const;
const CONTEXT_WINDOW = 200_000;
// What's said to the main agent carries when it was said, for the model; the apps show it without.
const stamped = (text: string) => `[${new Date().toString()}] ${text}`;

type Part = { type: string; text?: string };
export type Message = { role: string; content: string | Part[]; toolName?: string; toolCallId?: string; isError?: boolean };
// What a message says, its text parts joined.
export const textOf = (m: Message) => contentText(m.content as never).trim();

// The gate: a path's answer on its socket, its status and text.
export type GateCall = (method: string, path: string, body?: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
type McpTool = { name: string; description?: string; inputSchema: object; _meta?: Record<string, unknown> };

// MCP tools as pi-durable tools, each called (`call`) as whoever `as` names for its conversation (none: it isn't one
// of theirs); with `deferred`, those marked deferred (a remote service's, the gate says) load through tool_search.
export function asTools(list: McpTool[], as: (conversation: ConversationId) => Promise<string | undefined>, call: (who: string, name: string, args: Record<string, unknown>) => Promise<Partial<CallToolResult>>, opts: { deferred?: boolean } = {}) {
  return list.map((t) =>
    defineTool({
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema,
      ...(opts.deferred && t._meta?.["biscotti/deferred"] ? { deferred: true as const } : {}),
      execute: async (args, api): Promise<ToolExecutionResult> => {
        const who = await as(api.conversationId);
        if (!who) return { output: [{ type: "text", text: "not here" }] as never, isError: true };
        const result = await call(who, t.name, args as Record<string, unknown>);
        return { output: toLlmContent({ content: result.content ?? [], structuredContent: result.structuredContent }) as never, isError: Boolean(result.isError) };
      },
    }),
  );
}

// The gate's tools (its MCP endpoint, answering in JSON), as whoever `query` names: `session=<name>`, a main
// session's; `task=<id>`, a task's VM's.
export function gateMcp(call: GateCall) {
  const rpc = async (query: string, method: string, params: object) => {
    const res = await call("POST", `/mcp?${query}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    if (res.status >= 300) throw new Error(`the gate: ${res.text}`);
    const reply = JSON.parse(res.text) as { result?: unknown; error?: { message: string } };
    if (reply.error) throw new Error(reply.error.message);
    return reply.result as { tools?: McpTool[] } & Partial<CallToolResult>;
  };
  const tools = async (query: string, as: (conversation: ConversationId) => Promise<string | undefined>, opts: { deferred?: boolean } = {}) =>
    asTools((await rpc(query, "tools/list", {})).tools ?? [], as, (who, name, args) => rpc(who, "tools/call", { name, arguments: args }), opts);
  return { rpc, tools };
}

// What the gate says first (connect.ts).
interface Hello {
  prompt: string;
  models: Record<string, string>;
  methods: string[];
  plugins: string[];
}

// The link to the gate, opened again whenever it ends (the gate restarted): a hello, `onHello`, then ready.
function gateLink(sockets: string) {
  const handlers = new Map<string, (params: any, signal: AbortSignal) => unknown>();
  const notifications = new Map<string, (params: any) => void>();
  let ready = Promise.withResolvers<MessageConnection>();
  let onHello: (hello: Hello) => Promise<void>;
  function open() {
    const socket = connect(`${sockets}/link.sock`);
    // The gate isn't listening yet (it's starting).
    socket.once("error", () => setTimeout(open, 1000));
    socket.once("connect", () => {
      socket.removeAllListeners("error").on("error", () => socket.destroy());
      const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
      // The gate's requests under way: each ends when the gate cancels it, or goes away.
      const running = new Set<AbortController>();
      conn.onRequest((method, params, token) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error(`no method ${method}`);
        const ended = new AbortController();
        token.onCancellationRequested(() => ended.abort(new Error("stopped")));
        running.add(ended);
        return Promise.resolve(handler(params, ended.signal)).finally(() => running.delete(ended));
      });
      conn.onNotification((method, params) => notifications.get(method)?.(params));
      conn.onClose(() => {
        for (const ended of running) ended.abort(new Error("the gate went away"));
        conn.dispose();
        ready = Promise.withResolvers();
        setTimeout(open, 1000);
      });
      conn.listen();
      conn
        .sendRequest<Hello>("hello")
        .then((hello) => onHello(hello))
        .then(() => (conn.sendNotification("ready"), ready.resolve(conn)))
        .catch((err: Error) => (console.error(`the gate's hello: ${err.message}`), socket.destroy()));
    });
  }
  return {
    start(hello: (hello: Hello) => Promise<void>) {
      onHello = hello;
      open();
    },
    handle: (method: string, fn: (params: any, signal: AbortSignal) => unknown) => void handlers.set(method, fn),
    on: (method: string, fn: (params: any) => void) => void notifications.set(method, fn),
    request: async <T>(method: string, params?: unknown) => (await ready.promise).sendRequest<T>(method, params),
    notify: async (method: string, params?: unknown) => void (await ready.promise).sendNotification(method, params),
  };
}

// What a plugin's agent side (Plugin.agent, default-exporting a function of this) gets.
export interface AgentApi {
  harness(): Harness;
  ctx: RunContext;
  // The gate's answer on its socket (its tools, through gateMcp).
  call: GateCall;
  sockets: string;
  // Its own requests of its gate side, and handlers for theirs.
  link: Pick<ReturnType<typeof gateLink>, "request" | "notify" | "handle" | "on">;
  registry: { install(e: Extension): void };
  // A session's chats changed (AHP).
  changed(session: string): void;
}
// And gives.
export interface AgentPart {
  // Where a conversation's tools run, when it isn't here (a task's VM).
  env?(conversation: ConversationId): Promise<ExecutionEnv | undefined>;
  // Once the agent has started: what its stop cut off is settled.
  settle?(): Promise<void>;
  // The gate is new (it restarted): its tools may have changed.
  reload?(): void;
  // Chats beside a session's own conversation, for AHP (a task's, a VM's), each with its record for the apps
  // (the session's _meta.biscotti.chats).
  chats?: {
    list(session: string): Chat[];
    records(session: string): Record<string, unknown>;
    send(key: string, text: string): Promise<string | undefined>;
    cancel(key: string): Promise<void>;
    dispose(key: string): Promise<void>;
  };
}

// `store`: the agent's own database's directory and key.
export async function runAgent(sockets: string, store: { dir: string; key: string }) {
  // pi-ai's fetch can't reach a unix socket: a port here relays to the gate's.
  const relay = createTcpServer((client) => {
    const gate = connect(`${sockets}/gate.sock`);
    client.pipe(gate).pipe(client);
    gate.on("error", () => client.destroy());
    client.on("error", () => gate.destroy());
  });
  const port = await new Promise<number>((resolve) => relay.listen(0, "127.0.0.1", () => resolve((relay.address() as { port: number }).port)));
  const gateUrl = `http://127.0.0.1:${port}`;
  // The gate's answer, named as the gate (it takes a task's calls only from the hosts it knows).
  const call: GateCall = (method, path, body, headers = {}) => answer(`${sockets}/gate.sock`, method, path, body, { host: "gate", ...headers });
  const gateTools = gateMcp(call);
  const link = gateLink(sockets);

  const models = createModels();
  models.setProvider(
    createProvider({
      id: "biscotti",
      baseUrl: `${gateUrl}/llm`,
      auth: { apiKey: { name: "the gate", resolve: async () => ({ auth: { apiKey: "added-by-the-gate" } }) } },
      // The gate's names for its models: the main agent's, tasks' and coding tasks'.
      models: ["main", "task", "code"].map((id) => ({
        id,
        name: id,
        api: "openai-completions" as const,
        provider: "biscotti",
        baseUrl: `${gateUrl}/llm`,
        reasoning: true,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 32_768,
        // A plain OpenAI-compatible endpoint (the gate, in front of DeepSeek and others): a system role, no store.
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" as const },
      })),
      api: openAICompletionsApi(),
    }),
  );

  // pi-durable's storage. better-sqlite3 (for the cipher) refuses get and all on a statement that returns nothing,
  // which chord's adapter (written for node:sqlite) may ask.
  const sqlite = openEncrypted(`${store.dir}/durable.db`, store.key);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const lenient = {
    exec: (sql: string) => sqlite.exec(sql),
    close: () => sqlite.close(),
    prepare(sql: string) {
      const s = sqlite.prepare(sql);
      return s.reader ? s : { run: (...p: unknown[]) => s.run(...p), get: (...p: unknown[]) => void s.run(...p), all: (...p: unknown[]) => (s.run(...p), []) };
    },
  };

  const registry = createRegistry();
  const toolSearch = createToolSearchExtension();
  registry.install(toolSearch);
  // Each conversation's session, so the gate's tools know whose call it is.
  const sessionOf = new Map<string, string>();
  let installed!: Extension;
  let names: Record<string, string> = {};
  // The apps' methods (x-biscotti/<name>), passed to the gate as they come: the ones it said it has.
  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};
  const parts: AgentPart[] = [];
  let harness!: Harness;
  let ahp!: ReturnType<typeof durableAhp>;
  const api: AgentApi = { harness: () => harness, ctx, call, sockets, link, registry, changed: (session) => ahp.changed(session) };

  // What each session says, as it's committed, for memory: the gate's searchable transcript.
  const transcribe = (session: string, entries: readonly Entry[]) => {
    const rows = entries.flatMap((entry) => {
      const message = entry.model?.[0];
      if (!message) return [];
      const said = textOf(message as Message);
      return [{ id: String(entry.id), entry, text: said && (message.role === "user" || message.role === "assistant") ? `${message.role}: ${said}` : null }];
    });
    if (rows.length) void link.notify("transcript", { session, rows });
  };

  // One turn: the reply (everything said this run), or undefined when the message steered a run already going.
  // `origin`: who it's from (AHP's message kinds), the owner's ("user") or biscotti's own (a task report, a wake).
  async function reply(session: string, message: string, origin = "user"): Promise<string | undefined> {
    const handle = await ahp.conversation(session);
    if (message.trim() === "/compact")
      return handle.compact(undefined, ctx).then(
        () => "Compacted: the conversation so far is summarized, freeing its context.",
        (err: Error) => `Nothing compacted: ${err.message}`,
      );
    const text = stamped(message);
    const entry = inputFrom(origin);
    const live = await harness.snapshot(LiveDoc, handle.id, ctx);
    if (live?.run !== undefined) {
      await handle.submit({ type: "input", content: text, whenBusy: "steer", ...entry }, ctx);
      return undefined;
    }
    const settled = await (await handle.submit({ type: "input", content: text, ...entry }, ctx)).wait(ctx);
    if (settled.status !== "done") return `(That turn ended without an answer: ${(settled as { reason?: string }).reason ?? "unknown"}.)`;
    const context = await handle.context(ctx);
    const turn: string[] = [];
    for (const m of [...context.messages].reverse()) {
      if (m.role === "user") break;
      if (m.role !== "assistant") continue;
      const said = textOf(m as Message);
      if (said) turn.unshift(said);
    }
    return turn.join("\n\n");
  }
  link.handle("turn", ({ text, session = "main", origin }: { text: string; session?: string; origin?: string }) => reply(String(session), String(text), origin).then((r) => ({ reply: r })));

  // Started on the first hello: the plugins' sides, the conversations, and the sessions the apps see.
  async function start(hello: Hello) {
    for (const plugin of hello.plugins) parts.push((await import(plugin)).default(api) as AgentPart);
    harness = await Harness.open(
      await SqliteStorage.open(new NodeSqliteDatabase(lenient as never), { prefix: "pi_" }),
      {
        models,
        registry,
        // The main agent's sessions have biscotti's tools; a plugin's conversations (tasks) choose their own.
        settings: () => ({ compaction: { reserveTokens: 16_384 }, extensions: [installed, toolSearch] }),
        env: async ({ conversationId }) => {
          for (const part of parts) {
            const env = await part.env?.(conversationId);
            if (env) return env;
          }
          return undefined;
        },
        onReport: (report) => console.error(`pi-durable: ${report.kind}${report.error ? `: ${String(report.error)}` : ""}`),
      },
      ctx,
    );
    harness.resume();
    for (const part of parts) await part.settle?.();
    // "main" is the owner's texts (the root conversation), the others an app's; a session's tasks and VMs are chats
    // beside it (the tasks plugin's).
    const chats = parts.find((p) => p.chats)?.chats;
    ahp = durableAhp({
      harness: () => harness,
      context: ctx,
      info: { name: "biscotti", version: process.env.BISCOTTI_VERSION ?? "dev" },
      agent: { provider: "biscotti", displayName: "biscotti", description: "biscotti's main agent" },
      create: (session) =>
        session === "main" ? harness.root(ctx, { agent: { model: MAIN_MODEL } }) : harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MAIN_MODEL } }, ctx),
      opened: (session, handle) => void sessionOf.set(String(handle.id), session),
      // A session's own conversation only: its tasks' and VMs' chats aren't the owner's.
      committed: (session, entries, key) => key === undefined && transcribe(session, entries),
      title: (session) => (session === "main" ? "Texts" : undefined),
      meta: (session) => ({ biscotti: { kind: "main", model: names.main, size: CONTEXT_WINDOW, ...(session === "main" && { source: "imessage" }), chats: chats?.records(session) ?? {} } }),
      chats: (session) => chats?.list(session) ?? [],
      send: (_session, key, text) => chats?.send(key, text) ?? Promise.resolve("no such chat"),
      cancel: (_session, key) => chats?.cancel(key) ?? Promise.resolve(),
      dispose: (_session, key) => chats?.dispose(key) ?? Promise.resolve(),
      named: (id) => names[id] ?? id,
      // Inputs carry the time they were sent, for the model; the chat shows what was said.
      input: stamped,
      said: (text) => text.replace(/^\[[^\]]*\] /, ""),
      methods,
    });
    // The owner's texts are a session from the start, not only once something's said in them.
    await ahp.conversation("main");
  }

  // Each hello (the first, and a restarted gate's): its tools and prompt, its models' names and its methods.
  const started = Promise.withResolvers<void>();
  link.start(async (hello) => {
    const tools = await gateTools.tools("session=main", async (c) => `session=${encodeURIComponent(sessionOf.get(String(c)) ?? "main")}`, { deferred: true });
    installed = defineExtension({ name: "biscotti", sections: [section("biscotti", () => hello.prompt, { tag: false })], tools });
    registry.install(installed);
    names = hello.models;
    for (const name of Object.keys(methods)) delete methods[name];
    for (const name of hello.methods) methods[`x-biscotti/${name}`] = (params) => link.request("method", { name, params });
    if (harness) for (const part of parts) part.reload?.();
    else await start(hello);
    started.resolve();
  });
  await started.promise;

  const server = createServer((_req, res) => void res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => (new URL(req.url ?? "/", "http://agent").pathname === "/ahp" ? ahp.upgrade(req, socket, head) : socket.destroy()));
  await listen(server, `${sockets}/agent.sock`);
  return { gateUrl };
}
