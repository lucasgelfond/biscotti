import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
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
  // A text (and an image) straight to the owner, outside the conversation.
  send(text: string, image?: Buffer): Promise<void>;
  // Task VMs, on the machines plugins add (none: it refuses tasks).
  vms: Vms;
  // An HTTP route on the owner's API (API_PORT, published on the tailnet): `prefix` and everything under it, for the
  // owner only (Tailscale-User-Login, API_OWNER).
  route(prefix: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown): void;
}

// A task VM, in a slot of a host.
export interface Vm {
  slot: number;
  stop(): Promise<void>;
  // Pauses it and saves it (memory and disk) as `id`, freeing the slot; the host's `resume` brings it back. One that
  // can't be saved but carries on as it was rejects with `running` set on the error.
  suspend?(id: number): Promise<void>;
}

// The vms service's answer when a VM couldn't be saved but carries on (409), as Vm.suspend's error says it.
export const stillRunning = (err: Error & { status?: number }) => Promise.reject(Object.assign(err, { running: err.status === 409 }));

// Where task VMs run: this machine's vms service, or a plugin's machines (Vms.addHost): Firecracker here or on EC2,
// a Mac's. Every one is asked the same things; only `restore` is required. Slot numbers are the host's own; this
// machine's are 1 to VM_SLOTS.
export interface Host {
  // What kind of machine, for asking for one by kind ("local", "cloud", "mac", …): "cloud" for an overflow host,
  // "local" otherwise, by default.
  label?: string;
  slots: number[];
  restore(slot: number): Promise<Vm>;
  resume?(slot: number, id: number): Promise<Vm>;
  discard?(slot: number, id: number): Promise<void>;
  // Sets the slot's VM up: a key authorized for ssh (the gate's, for pi-env, or the owner's), a repo checked out (a git
  // bundle), a setup command run; each optional. Answers with its ssh host key. By default the VM image's own setup
  // (prepareVm, core/vm/task/biscotti-task).
  prepare?(slot: number, setup: Setup): Promise<string | undefined>;
  // Where the gate reaches port `port` of the slot's VM, and where that VM reaches the gate (a listener that takes only
  // `peer()`).
  endpoint(slot: number, port: number): { host: string; port: number };
  gate(slot: number): { host: string; port: number; peer(): string | undefined };
  // Where the owner reaches the slot's VM's sshd, when it isn't the endpoint for port 22 (a port on the tailnet).
  ssh?(slot: number): { host: string; port: number };
  // The slot's live desktop.
  watch?(slot: number): string | Promise<string>;
  // The slot's VM's web server (its port 8000), for a preview of what a task made.
  site?(slot: number): string | Promise<string>;
  // Whether someone's on the slot's VM (an ssh or desktop session).
  active?(slot: number): boolean | Promise<boolean>;
  // A host that costs money to run: used only once every other host's slots are taken, and never kept warm.
  overflow?: boolean;
  // pi-env's daemon in the slot's VM with `args`, piped to `socket` once it's starting (after answering the upgrade,
  // "HTTP/1.1 101"); over ssh to its port 22 otherwise (vm-env.ts).
  env?(slot: number, args: string[], socket: Duplex): Promise<void>;
}

// What happens to tasks and VMs, as events naming the task (or VM) number: for the board (the owner's apps) and
// plugins (push notifications).
export interface TaskEvent {
  id: number;
  type: "queued" | "started" | "report" | "kept" | "done" | "failed" | "resumed";
  at: number;
  goal?: string;
  slot?: number;
  where?: string;
  text?: string;
  // Fields a plugin adds for its own VMs (ssh-vms).
  [field: string]: unknown;
}
export const taskEvents = new EventEmitter<{ event: [TaskEvent] }>();
taskEvents.setMaxListeners(100);
export const emit = (event: Omit<TaskEvent, "at">) => taskEvents.emit("event", { ...event, at: Date.now() } as TaskEvent);

// Methods the owner's apps call (x-biscotti/<name> over AHP, agent.ts), each answered with what it's sent; plugins add
// theirs. `signal` aborts when the app goes away first.
export type AppMethod = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export const appMethods = new Map<string, AppMethod>();
export const appMethod = (name: string, handler: AppMethod) => void appMethods.set(name, handler);

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
  // The pull request its work became (vms.note).
  pr?: string;
}

// A VM still around once its task is done: open (running: kept open, or a plugin's, like an ssh VM) or asleep (kept on
// disk), with when it was last used (an ssh or desktop session on it, or its agent working) and its pull request.
export interface Alive {
  id: number;
  goal: string;
  asleep: boolean;
  used: number;
  pr?: string;
}
// One of them in a line, for the main agent.
const ago = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86400_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86400_000)} days`);
export const aliveLine = (v: Alive, now = Date.now()) =>
  `#${v.id} (${v.asleep ? "asleep" : "open"}, last used ${ago(now - v.used)} ago${now - v.used > 86400_000 ? ", idle over a day" : ""}${v.pr ? `, pull request ${v.pr}` : ""}): ${v.goal.replace(/\s+/g, " ").slice(0, 160)}`;

// `parent`: the main session that started it, where its report goes. A task's VM is deleted once it's done, unless
// `keep` (or vms.keep) keeps it open. `after` makes something of each run's result before it's reported, the first
// run's and each follow-up's (a coding task's commits pushed).
export type RunOptions = TaskOptions & {
  id?: number;
  fits?: (slot: number) => boolean;
  parent?: string;
  keep?: boolean;
  after?: (result: TaskResult) => Promise<TaskResult>;
};

export interface Vms {
  // A task whose report comes back to the caller. `fits` limits the slots it may take; `id` is one `reserve` gave.
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
  // A VM of the caller's own (not a task), numbered like tasks, until it gives it back: kept for later (`give`), or
  // thrown away (`drop`); `remove` deletes it for good, kept or not. `reclaim` brings a kept one back.
  // One with `sleep` may be put to sleep (`sleep.sleep(id)`, which gives it back) when every slot is held and another
  // needs one: the one whose `sleep.used(id)` is oldest.
  // `where`: a host's label ("local", "cloud", …), any by default.
  hold(goal: string, opts?: { model?: string; where?: string; fits?: (slot: number) => boolean; sleep?: Sleep }): Promise<{ id: number; vm: Vm }>;
  give(id: number): Promise<void>;
  drop(id: number): Promise<void>;
  reclaim(id: number, opts?: { model?: string; sleep?: Sleep }): Promise<Vm | undefined>;
  // A running task's or held VM's VM set up (Host.prepare), and the label of the host it's on.
  prepare(id: number, setup: Setup): Promise<string | undefined>;
  where(id: number): string | undefined;
  // Where the owner reaches its sshd.
  ssh(id: number): { host: string; port: number };
  // The labels of the hosts there are.
  labels(): string[];
  // pi-env's daemon in a running task's VM, for the main agent (agent-tasks.ts).
  env(id: number, args: string[], socket: Duplex): Promise<void>;
  // The live desktop of a running task's or held VM's, and its web server (a preview).
  watch(id: number): Promise<string | undefined>;
  site(id: number): Promise<string | undefined>;
  // A task's VM kept open once it's done (it's deleted otherwise), or an asleep one woken and kept open; false when
  // there's no such task or VM.
  keep(id: number): Promise<boolean>;
  // The VMs still around (open or asleep), and deleting one for good (a running task's once it's done).
  alive(): Alive[];
  remove(id: number): Promise<boolean>;
  // What a task's or VM's work became.
  note(id: number, note: { pr?: string }): void;
  addHost(host: Host): Promise<void>;
}

// How a held VM goes to sleep for another that needs its slot, and when it was last used (ms since the epoch).
export interface Sleep {
  used(id: number): number;
  sleep(id: number): Promise<void>;
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
  complete(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
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

// A tool the main agent loads only when it looks for one like it (pi's tool_search), so a remote service's many
// tools aren't in every model call: GitHub's and Notion's are ~350 KB of definitions.
export const DEFERRED = "biscotti/deferred";
export const deferred = (tool: Tool): Tool => ({ ...tool, _meta: { ...tool._meta, [DEFERRED]: true } });

// A session per call, so a paused call resumes in its own session. Its tools are deferred.
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
    list: () => withClient(async (client) => (await client.listTools()).tools.map(deferred)),
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
export function vmEndpoint(slot: number, port: number) {
  const at = endpoints.get(slot);
  if (!at) throw new Error(`no machine has slot ${slot}`);
  return at(port);
}

export interface Setup {
  key?: string;
  repo?: Buffer;
  setup?: string;
}

// How long a VM's setup (a checkout, a setup command) may take.
const PREPARE_TIMEOUT_MS = 30 * 60_000;
// The VM's task agent (core/vm/task/biscotti-task) sets it up: the key authorized, the repo checked out, the setup
// command run. It answers with the VM's host key.
export function prepareVm({ host, port }: { host: string; port: number }, message: Setup) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.end(JSON.stringify({ box: { key: message.key, repo: message.repo?.toString("base64"), setup: message.setup } })));
    const timer = setTimeout(() => socket.destroy(new Error("setting up the VM took too long")), PREPARE_TIMEOUT_MS);
    let done = false;
    createInterface({ input: socket, crlfDelay: Infinity })
      .on("error", () => {})
      .on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type !== "box") return;
          done = true;
          clearTimeout(timer);
          if (event.ok) resolve(event.hostKey);
          else reject(new Error(event.error ?? "the VM couldn't be set up"));
        } catch {}
      });
    socket.on("error", (err) => (clearTimeout(timer), reject(err)));
    // TODO: an ssh VM on an EC2 node ends here (its setup closes the connection); tasks there set up fine.
    socket.on("close", () => (clearTimeout(timer), done || reject(new Error("the VM closed the connection"))));
  });
}
