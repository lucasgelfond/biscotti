import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import type { Db } from "./memory.ts";
import { vault } from "./schema.ts";

// The plugin API. A plugin is plugins/<name>/index.ts default-exporting a Plugin; biscotti.json picks them.

export type { CallToolResult, Tool };

export interface Context {
  db: Db;
  dir: string;
  // A required setting; throws if missing.
  env(name: string): string;
  // A yes-or-no question for the owner (no answer in 10 minutes is no).
  ask(question: string): Promise<boolean>;
  // A message into one of the main agent's sessions (a wake, a task report; "main", the owner's texts, unless said):
  // the reply goes to the owner there.
  deliver(text: string, image?: Buffer, session?: string): Promise<void>;
  // The owner's message in a main session (from one of their apps): the agent answers there, as events.
  converse?(session: string, message: string): Promise<void>;
  // A text (and an image) straight to the owner, outside the conversation.
  send(text: string, image?: Buffer): Promise<void>;
  // Task VMs, where this machine has them.
  vms?: Vms;
  // An HTTP route on the owner's API (API_PORT, published on the tailnet): `prefix` and everything under it, for the
  // owner only (Tailscale-User-Login, API_OWNER).
  route(prefix: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown): void;
}

// A task VM, in a slot of a host.
export interface Vm {
  slot: number;
  stop(): Promise<void>;
  // Pauses it and saves it (memory and disk) as `id`, freeing the slot; the host's `resume` brings it back.
  suspend?(id: number): Promise<void>;
}

// Where task VMs run: this machine's vms service, or a plugin's machines (Vms.addHost). Slot numbers are the host's
// own; this machine's are 1 to VM_SLOTS.
export interface Host {
  slots: number[];
  restore(slot: number): Promise<Vm>;
  resume?(slot: number, id: number): Promise<Vm>;
  discard?(slot: number, id: number): Promise<void>;
  // Where the gate reaches port `port` of the slot's VM (10.200.<slot>.2 otherwise), and where that VM reaches the
  // gate (a listener that takes only `peer()`).
  endpoint?(slot: number, port: number): { host: string; port: number };
  gate?(slot: number): { host: string; port: number; peer(): string | undefined };
  // The slot's live desktop.
  watch?(slot: number): string | Promise<string>;
  // A host that costs money to run: used only once every other host's slots are taken, and never kept warm.
  overflow?: boolean;
}

// What happens to tasks and VMs, as events naming the task (or VM) number: for the owner's apps (the api plugin).
export interface TaskEvent {
  id: number;
  type: "queued" | "started" | "step" | "told" | "replied" | "status" | "report" | "kept" | "done" | "failed" | "resumed" | "moving" | "moved";
  at: number;
  goal?: string;
  slot?: number;
  where?: "local" | "cloud";
  text?: string;
  tool?: string;
  screenshot?: Buffer;
  // Fields a plugin adds for its own VMs (ssh-vms).
  [field: string]: unknown;
}
export const taskEvents = new EventEmitter<{ event: [TaskEvent] }>();
taskEvents.setMaxListeners(100);
export const emit = (event: Omit<TaskEvent, "at">) => taskEvents.emit("event", { ...event, at: Date.now() } as TaskEvent);

export interface Running {
  id: number;
  goal: string;
  slot?: number;
  started: number;
}
// A finished or stopped task's VM, or a closed VM of a plugin's, kept (suspended) for later.
export interface Kept {
  id: number;
  goal: string;
  slot: number;
  at: number;
}

// `parent`: the main session that started it, where its report goes.
export type RunOptions = TaskOptions & { id?: number; fits?: (slot: number) => boolean; extra?: Record<string, unknown>; parent?: string };

export interface Vms {
  // A task whose report comes back to the caller. `fits` limits the slots it may take; `id` carries on a kept task's
  // number (a moved one); `extra` goes to the VM's task agent with the goal.
  run(goal: string, opts?: RunOptions): Promise<TaskResult>;
  // A number for a task or VM to come (`run`'s `id`), so a client can name it before it starts.
  reserve(): number;
  // A task like the main agent's task tool starts: its report goes to the main agent. Its number.
  start(goal: string, opts?: RunOptions): number;
  // The owner's message for a task: given to it running, held for it queued, or a kept one resumed with it.
  tell(id: number, message: string): "told" | "queued" | "resumed" | "none";
  stop(id: number): boolean;
  running(): Running[];
  kept(): Kept[];
  // A VM of the caller's own (not a task), numbered like tasks, until it gives it back: kept for later (`give`),
  // thrown away (`drop`), or deleted for good once kept (`forget`). `reclaim` brings a kept one back.
  hold(goal: string, opts?: { model?: string; fits?: (slot: number) => boolean }): Promise<{ id: number; vm: Vm }>;
  give(id: number): Promise<void>;
  drop(id: number): Promise<void>;
  reclaim(id: number, opts?: { model?: string }): Promise<Vm | undefined>;
  forget(id: number): Promise<boolean>;
  // The live desktop of a running task's or held VM's.
  watch(id: number): Promise<string | undefined>;
  addHost(host: Host): Promise<void>;
}

export interface TaskOptions {
  repo?: Buffer;
  // A plugin's own agent instead of pi: file name -> source, run in the VM as `node main.ts` with the goal on stdin
  // (what it prints is the report). It reaches the gate at http://gate like pi does.
  runner?: Record<string, string>;
  model?: string;
  timeoutMs?: number;
  // The desktop's shape: "mobile" (portrait, phone-sized) when the owner will watch from a phone, "desktop" otherwise.
  display?: "mobile" | "desktop";
}

export interface TaskResult {
  report: string;
  screenshot?: Buffer;
  bundle?: Buffer;
}

export interface Channel {
  messages: AsyncIterable<{ text: string }>;
  send(message: { text: string } | { image: Buffer }): Promise<void>;
}

// Who's calling a tool: the main agent, or the task VM in `slot`, running task number `task` (one per run, so what a
// plugin keeps for a task, like an approval, ends with it).
export interface Caller {
  // For the main agent: which of its sessions ("main": the owner's texts; otherwise its number).
  session?: string;
  slot?: number;
  task?: number;
  // What that task was asked: its goal, then the owner's later messages (tell_task).
  asked?: string;
}

export interface Tools {
  list(): Promise<Tool[]>;
  call(name: string, args: Record<string, unknown>, caller?: Caller): Promise<CallToolResult>;
  // The subset task VMs may use (untrusted: web content drives them). Without it, task VMs get none of these.
  tasks?: Tools;
}

export interface Recall {
  index(id: number, text: string): Promise<void>;
  search(query: string): Promise<number[]>;
}

// Watches what goes through the gate (e.g. to trace it): each turn of the main agent, each model call and each tool
// call, with saved secrets already placeholders. Each returns what to call once it's done; neither may throw.
export interface Observer {
  turn?(message: string): (reply?: string, error?: unknown) => void;
  llm?(call: { slot?: number; model: string; request: Record<string, unknown> }): (response: { status: number; body: string }) => void;
  tool?(call: { name: string; args: Record<string, unknown>; slot?: number }): (result?: CallToolResult, error?: unknown) => void;
}

// A model backend in place of LLM_BASE_URL for some of the gate's models (`models`: main, task, code -> the backend's
// model id). The gate scrubs, maps and observes the call as for any other; `complete` gets the OpenAI chat completions
// request with `model` already mapped, and answers as an OpenAI-compatible API would (SSE when `stream` is set).
// A backend that answers 402, 429 or 503 is skipped for a while, for LLM_BASE_URL.
export interface Llm {
  models: Record<string, string>;
  complete(body: Record<string, unknown>, signal: AbortSignal, call: LlmCall): Promise<Response>;
}

// Whose call it is: the gate's model name (main, task, code, or another a backend serves), and for a task VM its
// slot and task (one per run).
export interface LlmCall {
  name: string;
  slot?: number;
  task?: number;
}

export interface Plugin {
  prompt?: string;
  llm?(ctx: Context): Promise<Llm>;
  channel?(ctx: Context): Promise<Channel>;
  tools?(ctx: Context): Promise<Tools>;
  recall?(ctx: Context): Promise<Recall>;
  observe?(ctx: Context): Promise<Observer>;
  start?(ctx: Context): Promise<void>;
}

export const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });

// Tool input schemas, e.g. `input({ to: str("An email address."), max: optional(int()) })`: every property is
// required unless it's `optional`.
type Schema = Record<string, unknown>;
const typed = (type: string) => (description?: string): Schema => ({ type, ...(description && { description }) });
export const str = typed("string");
export const int = typed("integer");
export const bool = typed("boolean");
export const list = (items: Schema, description?: string): Schema => ({ ...typed("array")(description), items });
const OPTIONAL = Symbol("optional");
export const optional = (schema: Schema): Schema => ({ ...schema, [OPTIONAL]: true });
export function input(properties: Record<string, Schema> = {}): Tool["inputSchema"] {
  const required = Object.keys(properties).filter((k) => !properties[k][OPTIONAL as never]);
  return { type: "object", properties, ...(required.length && { required }) };
}
export const declined = text("The user declined.");

export interface LocalTool {
  name: string;
  description: string;
  input: Tool["inputSchema"];
  run(args: Record<string, unknown>, caller: Caller): Promise<CallToolResult>;
}

export function localTools(defs: LocalTool[]): Tools {
  return {
    list: async () => defs.map(({ name, description, input }) => ({ name, description, inputSchema: input })),
    call: async (name, args, caller = {}) => defs.find((d) => d.name === name)!.run(args, caller),
  };
}

// Several sets as one: each call goes to the set that listed the tool.
export function merge(...sets: Tools[]): Tools {
  const owners = new Map<string, Tools>();
  const list = async () => (await Promise.all(sets.map(async (s) => (await s.list()).map((t) => (owners.set(t.name, s), t))))).flat();
  return {
    list,
    call: async (name, args, caller) => (owners.get(name) ?? (await list(), owners.get(name))!).call(name, args, caller),
  };
}

// A session per call, so a paused call resumes in its own session.
export function mcpTools(url: string, headers: Record<string, string>, call?: (client: Client, name: string, args: Record<string, unknown>) => Promise<CallToolResult>): Tools {
  async function withClient<T>(fn: (client: Client) => Promise<T>) {
    const client = new Client({ name: "biscotti", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  return {
    list: () => withClient(async (client) => (await client.listTools()).tools),
    call: (name, args) =>
      withClient((client) => (call ? call(client, name, args) : (client.callTool({ name, arguments: args }) as Promise<CallToolResult>))),
  };
}

// A vault entry's values, and saving one, for plugins that keep keys there or type them in.
export { secrets } from "./vault.ts";
export const secret = (db: Db, name: string) => db.select().from(vault).where(eq(vault.name, name)).get()?.value;
export function saveSecret(db: Db, name: string, value: Record<string, string>) {
  const row = { name, fields: Object.keys(value), value };
  db.insert(vault).values(row).onConflictDoUpdate({ target: vault.name, set: row }).run();
}

// A page biscotti serves the owner (a vault form, a sign-in callback), styled like biscotti's site.
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const ART = [
  "        _.-~~~~~~~~~~~~~~~~~~~~-._",
  "     .-'  o    .   (_)    .   o   '-.",
  "    /  .   (_)   .    o   (_)   .    \\",
  "   /  o   .    o   (_)   .    o   .   \\",
  "  /__(_)____.____o____.____(_)____o____\\",
].join("\n");
// The site's look, for the pages biscotti serves: these forms, and plugins' pages (artifacts).
export const PAGE_STYLE = `body{margin:0;background:#fff;color:#000;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;letter-spacing:-.01em}
pre{margin:0 0 24px;font-size:11px;line-height:1.2;overflow-x:auto}
h1{font-size:15px;font-weight:600;margin:0 0 24px}
a{color:#2400ff}
label{display:block;margin:0 0 16px}
input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:8px;font:inherit;border:1px solid #000;border-radius:0;background:#fff}
input:focus{outline:2px solid #2400ff;outline-offset:-1px}
button{font:inherit;padding:6px 14px;border:1px solid #000;background:#fff;color:#000;cursor:pointer}
button:hover{background:#000;color:#fff}`;
export const PAGE_ART_TEXT = ART;
export const PAGE_ART = `<pre aria-hidden="true">${ART}</pre>`;
export const sendPage = (res: ServerResponse, title: string, body: string, status = 200) =>
  void res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage(title, body));
const htmlPage = (title: string, body: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
${PAGE_STYLE}
main{max-width:480px;margin:0 auto;padding:40px 16px 64px}
</style>
<main>${PAGE_ART}${body}</main>`;

// Where the gate reaches port `port` of the task VM in `slot`: its host's endpoint, or this machine's slot link.
export const endpoints = new Map<number, (port: number) => { host: string; port: number }>();
export const vmEndpoint = (slot: number, port: number) => endpoints.get(slot)?.(port) ?? { host: `10.200.${slot}.2`, port };

