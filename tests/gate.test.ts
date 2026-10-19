import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { localTools, text, type Plugin } from "../core/src/plugin.ts";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createGate } from "../core/src/gate.ts";
import { boot } from "./support.ts";

async function mcp(url: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const sent: string[] = [];
const outbox: Plugin = {
  tools: async (ctx) =>
    localTools([
      {
        name: "send_postcard",
        description: "Send a postcard.",
        input: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        async run({ to }) {
          if (!(await ctx.ask(`Send a postcard to ${to}?`))) return text("The user declined.");
          sent.push(to as string);
          return text("Sent.");
        },
      },
    ]),
};

test("answers a task VM's model call with the host's chosen model and key", async () => {
  const { gateUrl } = await boot([]);

  const res = await fetch(`${gateUrl}/llm/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer added-by-the-gate" },
    body: JSON.stringify({ model: "task", max_tokens: 200, messages: [{ role: "user", content: "Reply with just the word biscotti." }] }),
  });
  const body = await res.json();
  const unknown = await fetch(`${gateUrl}/llm/chat/completions`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-opus-5-5" }) });

  expect(res.status).toBe(200);
  expect(body.choices[0].message.content.toLowerCase()).toContain("biscotti");
  expect(unknown.status).toBe(400);
});

test("replaces saved secrets in model calls before they leave for the provider", async () => {
  const received: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const secrets = [
    { label: "Delta login.password", value: "hunter2-biscotti" },
    { label: "Visa.number", value: "4111111111111111" },
  ];
  const gate = createGate({ llm: { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, key: "k" }, models: { task: "m" }, send: async () => {}, secrets: () => secrets });
  const server = await gate.listen("127.0.0.1", 0);
  const message = "My password is hunter2-biscotti and my card is 4111 1111 1111 1111.";

  await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "task", messages: [{ role: "user", content: message }] }),
  });
  server.close();
  upstream.close();
  const sentUpstream = JSON.parse(received[0]).messages[0].content;

  expect(sentUpstream).toBe("My password is [vault:Delta login.password] and my card is [vault:Visa.number].");
});

test("asks the owner before a tool that needs a yes, and goes ahead on their yes", async () => {
  const biscotti = await boot([outbox]);

  const replied = biscotti.say("Send a postcard to Grandma (her address is 12 Elm St, Springfield) saying we miss her. Go ahead, use send_postcard.");
  await expect.poll(() => biscotti.sent.join("\n"), { timeout: 60_000 }).toContain("Send a postcard to");
  await biscotti.say("yes");
  await replied;

  expect(sent.join("\n")).toMatch(/grandma/i);
  expect(biscotti.sent).toContain("Approved.");
});

test("lists every plugin's tools at the gate's /mcp", async () => {
  const { gateUrl } = await boot([outbox]);

  const gate = await mcp(`${gateUrl}/mcp`);
  const names = (await gate.listTools()).tools.map((t) => t.name);
  await gate.close();

  expect(names).toEqual(expect.arrayContaining(["send_postcard", "schedule", "list_wakes", "cancel_wake"]));
});

test("gives task VMs only the tools plugins allow them, and only when addressed as the gate", async () => {
  const tool = (name: string) => localTools([{ name, description: name, input: { type: "object" }, run: async () => text(name) }]);
  const gate = createGate({ llm: { url: "http://127.0.0.1:1", key: "unused" }, models: {}, send: async () => {} });
  gate.add({ ...tool("gmail_read"), tasks: undefined });
  gate.add({ ...tool("web_search"), tasks: tool("web_search") });
  const server = await gate.listen("127.0.0.1", 0, { slot: 1 });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

  const client = await mcp(url);
  const names = (await client.listTools()).tools.map((t) => t.name);
  const hidden = client.callTool({ name: "gmail_read", arguments: {} });
  await expect(hidden).rejects.toThrow("no tool gmail_read");
  await client.close();
  // As a page in the VM's browser would, through a DNS name rebound to the gate.
  const rebound = await new Promise<number>((resolve) =>
    request(url, { method: "POST", headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode!)).end(),
  );
  server.close();

  expect(names).toEqual(["web_search"]);
  expect(rebound).toBe(403);
});
