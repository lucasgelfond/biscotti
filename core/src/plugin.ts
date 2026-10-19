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
}

export interface Channel {
  messages: AsyncIterable<{ text: string; react(emoji: string): Promise<unknown> }>;
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

// A vault entry's values, for plugins whose keys can be saved there.
export const secret = (db: Db, name: string) => db.select().from(vault).where(eq(vault.name, name)).get()?.value;
