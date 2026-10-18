import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "./memory.ts";

// The plugin API: everything a plugin can rely on from the core, and everything it can give back. A plugin is a
// folder under plugins/ whose index.ts default-exports a Plugin; biscotti.json lists which ones load.

export type { CallToolResult, Tool };
export type { Db };

export interface Context {
  db: Db;
  // The data directory, for files a plugin keeps.
  dir: string;
  // A required setting (from the environment); throws if it's missing.
  env(name: string): string;
  // Asks the owner a yes-or-no question over the channel; resolves with their answer (no answer in 10 minutes is no).
  ask(question: string): Promise<boolean>;
  // A message into the conversation, as if the owner had sent it (a wake, a task report); the agent's reply and any
  // image go to the owner.
  deliver(text: string, image?: Buffer): Promise<void>;
}

// The owner's messaging channel: iMessage, email, … Only the owner's messages come through.
export interface Channel {
  messages: AsyncIterable<{ text: string; react(emoji: string): Promise<unknown> }>;
  send(message: { text: string } | { image: Buffer }): Promise<void>;
}

// Tools offered through the gate, to the main agent and to task VMs alike.
export interface Tools {
  list(): Promise<Tool[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

// Meaning-based recall, fused with the core's keyword search.
export interface Recall {
  index(id: number, text: string): Promise<void>;
  // Memory ids, best match first.
  search(query: string): Promise<number[]>;
}

export interface Plugin {
  // Lines added to the system prompt.
  prompt?: string;
  channel?(ctx: Context): Promise<Channel>;
  tools?(ctx: Context): Promise<Tools>;
  recall?(ctx: Context): Promise<Recall>;
  // Background work, started once everything is up.
  start?(ctx: Context): Promise<void>;
}

export const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });

// Tools that run in-process: each with a JSON schema for its arguments.
export function localTools(
  defs: { name: string; description: string; input: Tool["inputSchema"]; run(args: Record<string, unknown>): Promise<CallToolResult> }[],
): Tools {
  return {
    list: async () => defs.map(({ name, description, input }) => ({ name, description, inputSchema: input })),
    call: async (name, args) => defs.find((d) => d.name === name)!.run(args),
  };
}

// Tools from a remote MCP server. Each call gets its own session, so a paused call can resume in the one that paused it.
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
