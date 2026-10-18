import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { boot, toolCalls } from "./support.ts";

// The secrets plugin: the owner fills a one-time form, and the agent reads the secret back (asking first if marked).
process.env.SECRETS_KEY = randomBytes(32).toString("hex");
process.env.SECRETS_URL = "http://127.0.0.1:4791";
const biscotti = boot(["secrets/sqlite"]);

const formLink = (sent: string[]) => sent.join("\n").match(/http:\/\/127\.0\.0\.1:4791\/[0-9a-f]{32}/)?.[0];

test("saves a login through a one-time form and fills it back in", async () => {
  const { say, sent, db } = await biscotti;

  await say("I want to save my Delta login so you can book tickets. Send me the form.");
  const link = formLink(sent)!;
  const page = await (await fetch(link)).text();
  const saved = await fetch(link, { method: "POST", body: new URLSearchParams({ "f:username": "owner@example.com", "f:password": "hunter2-biscotti" }) });
  const reused = await fetch(link);
  // Saving tells the agent, which replies; wait for that before asking.
  const before = sent.length;
  await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(before);
  await say("Look up my Delta login and tell me just the username it's under.");

  const stored = db.$client.prepare("SELECT data FROM secrets").get() as { data: Buffer };
  expect(page).toContain('name="f:password"');
  expect(saved.status).toBe(200);
  expect(reused.status).toBe(404);
  expect(stored.data.toString("latin1")).not.toContain("hunter2");
  expect(toolCalls(db).flat()).toContain("mcp__biscotti__secret_get");
  expect(sent.join("\n")).toContain("owner@example.com");
});

test("asks the owner before using a secret marked 'ask me', and keeps it on a no", async () => {
  const { say, sent } = await biscotti;
  sent.length = 0;

  await say("Send me a form to save my Visa card: fields number and cvc.");
  const link = formLink(sent)!;
  const before = sent.length;
  await fetch(link, { method: "POST", body: new URLSearchParams({ "f:number": "4111111111111111", "f:cvc": "737", confirm: "on" }) });
  await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(before);
  sent.length = 0;

  const replied = say("Look up my Visa card's details: I'm about to check out on example.com for $20.");
  await expect.poll(() => sent.join("\n"), { timeout: 60_000 }).toContain("Reply yes or no");
  await say("no");
  await replied;

  expect(sent).toContain("Declined.");
  expect(sent.join("\n")).not.toContain("4111111111111111");
});
