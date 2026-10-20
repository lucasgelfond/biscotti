import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import type { Db } from "./memory.ts";
import { vault } from "./schema.ts";

// The plugin API. A plugin is plugins/<name>/index.ts default-exporting a Plugin; biscotti.json picks them.

export type { CallToolResult, Tool };
export type { Db };

export interface Context {
  db: Db;
  dir: string;
  // A required setting; throws if missing.
  env(name: string): string;
  // A yes-or-no question for the owner (no answer in 10 minutes is no).
  ask(question: string): Promise<boolean>;
  // A message into the conversation (a wake, a task report); the reply goes to the owner.
  deliver(text: string, image?: Buffer): Promise<void>;
  // A goal for a task VM, where this machine has them. With `repo` (a git bundle), the VM works on it in ~/repo and
  // its new commits come back as `bundle`; `model` names one of the gate's models.
  task?(goal: string, opts?: TaskOptions): Promise<TaskResult>;
}

export interface TaskOptions {
  repo?: Buffer;
  // A plugin's own agent instead of pi: file name -> source, run in the VM as `node main.ts` with the goal on stdin
  // (its last stdout line is the report). It reaches the gate at http://gate like pi does.
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

// Who's calling a tool: the main agent, or the task VM in `slot`.
export interface Caller {
  slot?: number;
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

export interface Plugin {
  prompt?: string;
  channel?(ctx: Context): Promise<Channel>;
  tools?(ctx: Context): Promise<Tools>;
  recall?(ctx: Context): Promise<Recall>;
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
