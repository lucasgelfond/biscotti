import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { localTools, text, type Plugin } from "../core/src/plugin.ts";
import { boot } from "./support.ts";

// The gate: the model and every plugin's tools, for the main agent and task VMs alike, with the owner's approvals.

async function mcp(url: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

// A plugin whose one tool needs the owner's yes, as sending an email or using a card does.
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

  // What pi in a VM sends: an Anthropic-style request for the generic "task" model, with no real key.
  const res = await fetch(`${gateUrl}/llm/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "added-by-the-gate" },
    body: JSON.stringify({ model: "task", max_tokens: 200, messages: [{ role: "user", content: "Reply with just the word biscotti." }] }),
  });
  const body = await res.json();
  const unknown = await fetch(`${gateUrl}/llm/v1/messages`, { method: "POST", body: JSON.stringify({ model: "anthropic/claude-opus-5-5" }) });

  expect(res.status).toBe(200);
  expect(JSON.stringify(body.content).toLowerCase()).toContain("biscotti");
  expect(unknown.status).toBe(400);
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
