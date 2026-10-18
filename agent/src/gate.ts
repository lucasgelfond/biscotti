import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// The gate: everything a task VM reaches beyond the internet comes through here, behind the bridge (Caddy), and every
// key stays on the host (Instinct-style: the VM asks, the host acts).
// - /llm: the model, through the AI Gateway. VMs ask for the model "task"; the gate picks the real one.
// - /search: Exa's MCP server.
// - /tools: Executor's tools. When Executor pauses a call for approval, the gate asks the owner and resumes or
//   declines; the VM never sees `resume`, so it can't approve anything.

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

// Streams a request on to `url`, minus the hop's own headers.
async function forward(res: ServerResponse, url: string, init: RequestInit) {
  const upstream = await fetch(url, init);
  const headers = Object.fromEntries(
    [...upstream.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name)),
  );
  res.writeHead(upstream.status, headers);
  for await (const chunk of upstream.body ?? []) res.write(chunk);
  res.end();
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function startGate(opts: {
  executorUrl: string;
  token: string;
  gatewayKey: string;
  taskModel: string;
  exaKey?: string;
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
    const path = req.url ?? "/";
    if (path.startsWith("/llm/")) {
      const body = JSON.parse(await readBody(req));
      if (body.model === "task") body.model = opts.taskModel;
      return forward(res, `https://ai-gateway.vercel.sh${path.slice("/llm".length)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.gatewayKey}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
    }
    if (path.startsWith("/search/") && opts.exaKey) {
      const headers = { "Content-Type": "application/json", Accept: String(req.headers.accept ?? "application/json"), "x-api-key": opts.exaKey };
      const session = req.headers["mcp-session-id"];
      return forward(res, `https://mcp.exa.ai${path.slice("/search".length)}`, {
        method: req.method,
        headers: session ? { ...headers, "mcp-session-id": String(session) } : headers,
        body: req.method === "POST" ? await readBody(req) : undefined,
      });
    }

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
