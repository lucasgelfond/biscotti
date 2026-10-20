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

test("after the gate restarts with a new plugin, the running agent uses its tools", { timeout: 120_000 }, async () => {
  const before = await boot([]);
  await before.say("Hi! Just say hello back.");
  const after = await boot([outbox], before.dir, before);

  const replied = after.say("Send a postcard to Grandpa at 3 Oak Lane with send_postcard. Go ahead.");
  await expect.poll(() => after.sent.join("\n"), { timeout: 60_000 }).toContain("Send a postcard to");
  await after.say("no");
  await replied;

  expect(after.sent).toContain("Declined.");
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

test("takes a whole-message yes or no as the answer, and lets anything else through to the agent", async () => {
  const texts: string[] = [];
  const gate = createGate({ llm: { url: "http://127.0.0.1:1", key: "unused" }, models: {}, send: async (t) => void texts.push(t) });
  const first = gate.ask("Fill the Visa card into delta.com?");

  const chatter = gate.answer("ok thanks, and what's the weather?");
  const approved = gate.answer("Yes!");
  const second = gate.ask("Send an email to Sam?");
  const declined = gate.answer("no");
  const nothingWaiting = gate.answer("yes");
  const results = [chatter, approved, declined, nothingWaiting];

  expect(results).toEqual([false, true, true, false]);
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(texts[0]).toContain("Reply yes or no.");
});

test("gives a task VM the task model whatever it names, only for chat completions, and only from its own slot", async () => {
  const models: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    models.push(`${req.url} ${JSON.parse(Buffer.concat(chunks).toString("utf8")).model}`);
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gate = createGate({ llm: { url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, key: "k" }, models: { main: "big-model", task: "small-model" }, send: async () => {} });
  const own = await gate.listen("127.0.0.1", 0, { slot: 1, peer: "127.0.0.1" });
  const other = await gate.listen("127.0.0.1", 0, { slot: 2, peer: "10.200.2.2" });
  const call = (server: typeof own, path: string, model: string) =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: "POST", body: JSON.stringify({ model, messages: [] }) }).then((r) => r.status);

  const statuses = [
    await call(own, "/llm/chat/completions", "main"),
    await call(own, "/llm/embeddings", "task"),
    await call(own, "/llm/models", "task"),
    await call(other, "/llm/chat/completions", "task"),
  ];
  own.close();
  other.close();
  upstream.close();

  expect(statuses).toEqual([200, 404, 404, 403]);
  expect(models).toEqual(["/v1/chat/completions small-model"]);
});
