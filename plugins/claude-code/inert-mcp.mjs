// The caller's tools for Claude Code to offer the model, none of which it can run: the gate's caller runs them.
// From pi-claude-code (github.com/earendil-works/pi-claude-code, MIT, src/inert-mcp.mjs).
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const tools = JSON.parse(await readFile(process.argv[2], "utf8"));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "biscotti-inert-tools", version: "1" } };
  else if (request.method === "tools/list") result = { tools };
  else if (request.method === "tools/call") result = { isError: true, content: [{ type: "text", text: "Denied: these tools run in biscotti, not Claude Code." }] };
  if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
