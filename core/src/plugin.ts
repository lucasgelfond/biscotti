import type { ServerResponse } from "node:http";
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
  // A message into the conversation (a wake, a task report); the reply goes to the owner.
  deliver(text: string, image?: Buffer): Promise<void>;
  // A text (and an image) straight to the owner, outside the conversation.
  send(text: string, image?: Buffer): Promise<void>;
  // A goal for a task VM, where this machine has them. With `repo` (a git bundle), the VM works on it in ~/repo and
  // its new commits come back as `bundle`; `model` names one of the gate's models.
  task?(goal: string, opts?: TaskOptions): Promise<TaskResult>;
}

export interface TaskOptions {
  repo?: Buffer;
  // A plugin's own agent instead of pi: file name -> source, run in the VM as `node main.ts` with the goal on stdin
  // (what it prints is the report). It reaches the gate at http://gate like pi does.
  runner?: Record<string, string>;
  model?: string;
  timeoutMs?: number;
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
  slot?: number;
  task?: number;
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

export interface Plugin {
  prompt?: string;
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
