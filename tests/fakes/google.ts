import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A stand-in for Google: an MCP server with a seeded inbox and calendar, which records the email it's asked to send.
// The read tools are marked read-only and sending destructive, so Executor asks before sending, as for the real thing.

export const inbox = [
  { from: "landlord@example.com", subject: "Rent reminder", body: "Rent of $2,400 is due November 1." },
  { from: "dentist@example.com", subject: "Appointment confirmed", body: "See you Tuesday, October 20 at 3:30pm." },
];
export const calendar = [
  { date: "2026-10-20", time: "15:30", title: "Dentist (Dr. Okafor)" },
  { date: "2026-10-21", time: "19:00", title: "Dinner with Sam at Lilia" },
];

const tools = [
  { name: "gmail_search", description: "Search the inbox.", annotations: { readOnlyHint: true }, properties: { query: { type: "string" } } },
  { name: "calendar_events", description: "List calendar events.", annotations: { readOnlyHint: true }, properties: {} },
  {
    name: "gmail_send",
    description: "Send an email.",
    annotations: { destructiveHint: true },
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
  },
];

export function startFakeGoogle(port: number) {
  const sent: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    const mcp = new Server({ name: "fake-google", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ properties, ...t }) => ({ ...t, inputSchema: { type: "object" as const, properties } })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const args = (params.arguments ?? {}) as Record<string, string>;
      const result =
        params.name === "gmail_search"
          ? inbox.filter((m) => JSON.stringify(m).toLowerCase().includes((args.query ?? "").toLowerCase()))
          : params.name === "calendar_events"
            ? calendar
            : (sent.push(args), { sent: true });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, "0.0.0.0");
  return { sent, close: () => server.close() };
}
