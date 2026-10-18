import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Executor's tools for task VMs, served behind the bridge's /tools route (Instinct-style: the VM asks, the host acts).
// The agent's token never leaves the host. When Executor pauses a call for approval, the pass-through itself asks
// the owner and resumes or declines; the VM never sees `resume`, so it can't approve anything.

interface Paused {
  requestId: string;
  message: string;
}

// Executor reports a paused call as JSON text: {"status":"approval-required","requestId":…,"elicitation":{…}}.
function paused(result: CallToolResult): Paused | undefined {
  const text = result.content?.find((c) => c.type === "text")?.text;
  try {
    const body = JSON.parse(text ?? "");
    if (body.status === "approval-required") return { requestId: body.requestId, message: body.elicitation?.message ?? "" };
  } catch {}
  return undefined;
}

export function startPassThrough(opts: {
  executorUrl: string;
  token: string;
  port: number;
  askOwner: (question: string) => Promise<boolean>;
}) {
  // One Executor session per request from a VM, so a paused call resumes in the session that paused it.
  async function withExecutor<T>(fn: (executor: Client) => Promise<T>) {
    const executor = new Client({ name: "biscotti-passthrough", version: "1" });
    await executor.connect(
      new StreamableHTTPClientTransport(new URL(`${opts.executorUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
      }),
    );
    try {
      return await fn(executor);
    } finally {
      await executor.close();
    }
  }

  async function call(name: string, args: Record<string, unknown>) {
    return withExecutor(async (executor) => {
      let result = (await executor.callTool({ name, arguments: args })) as CallToolResult;
      for (let p = paused(result); p; p = paused(result)) {
        const yes = await opts.askOwner(`A task wants to do this:\n${p.message.slice(0, 1200)}\n\nReply yes to allow it, or no.`);
        const response = { action: yes ? "accept" : "decline", ...(yes ? { content: {} } : {}) };
        result = (await executor.callTool({ name: "resume", arguments: { requestId: p.requestId, response } })) as CallToolResult;
      }
      return result;
    });
  }

  return createServer(async (req, res) => {
    const server = new Server({ name: "biscotti", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const { tools } = await withExecutor((executor) => executor.listTools());
      return { tools: tools.filter((t) => t.name !== "resume") };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "resume") throw new Error("Approvals go to the owner, not the task.");
      return call(request.params.name, request.params.arguments ?? {});
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(opts.port, "127.0.0.1");
}
