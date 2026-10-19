import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { approval, boot } from "./support.ts";

// A demo store (no real charge) and Stripe's test card. Runs on the Pi, with the live agent stopped.
const VM_DIR = (process.env.VM_DIR ??= "/var/lib/biscotti/vm");
process.env.FIRECRACKER ??= "/usr/local/bin/firecracker";
const onThePi = existsSync("/dev/kvm") && existsSync(`${VM_DIR}/desktop.snap`);
const ORDER = "Buy one Samsung galaxy s6 on demoblaze.com with my card, shipping to me in New York, USA.";
const CARD = { name: "Ada Lovelace", number: "4242424242424242", expiry: "12/30", cvc: "123" };

test.skipIf(!onThePi)("with no card saved, asks for one through a vault form instead of in chat", async () => {
  const { say, sent } = await boot([]);

  await say(ORDER);

  const texts = sent.join("\n");
  expect(texts).toContain(process.env.VAULT_URL);
  expect(texts).not.toMatch(/card number\?/i);
});

test.skipIf(!onThePi)("checks out with the saved card once the owner says yes", { timeout: 15 * 60_000 }, async () => {
  const b = await boot([]);
  b.db.$client.prepare("INSERT INTO vault VALUES ('Visa', ?, ?)").run(JSON.stringify(Object.keys(CARD)), JSON.stringify(CARD));

  await b.say(ORDER);
  await expect.poll(() => b.sent.join("\n"), { timeout: 10 * 60_000, interval: 1000 }).toContain("to approve");
  const asked = b.sent.find((t) => t.includes("to approve"))!;
  await b.say(approval(b.sent));
  await expect.poll(() => b.sent.join("\n"), { timeout: 10 * 60_000, interval: 2000 }).toMatch(/thanks? (you )?for your purchase|purchased|order (is )?(placed|complete)/i);

  expect(asked).toContain("Visa");
  expect(b.images.length).toBeGreaterThan(0);
  expect(b.sent.join("\n")).not.toContain(CARD.number);
});
