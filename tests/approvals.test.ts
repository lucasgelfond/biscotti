import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { vault } from "../core/src/schema.ts";
import secureFill, { devtools, targets } from "../plugins/secure-fill/index.ts";
import { CHROME, chrome, testContext } from "./support.ts";

// One yes per vault entry per task: what the owner is asked across a checkout's fills.

const CARD = { number: "4111111111111111", expiry: "12/30", cvc: "123" };
let close: (() => void)[] = [];
afterEach(() => {
  for (const c of close) c();
  close = [];
  delete process.env.TASK_BROWSER;
});

// secure-fill's task tools on the Chrome at `browser`, with every question answered by `answer` and kept in `asked`.
async function vaultFill(browser: string, answer = (_q: string) => true) {
  process.env.TASK_BROWSER = browser;
  const asked: string[] = [];
  const ctx = testContext({ ask: async (q) => (asked.push(q), answer(q)) });
  ctx.db.insert(vault).values([
    { name: "Card", fields: Object.keys(CARD), value: CARD },
    { name: "Login", fields: ["password"], value: { password: "hunter2-biscotti" } },
  ]).run();
  const tools = (await secureFill.tools!(ctx)).tasks!;
  const fill = (name: string, fields: string[], task?: number) => tools.call("vault_fill", { name, fields, why: "2 tickets, $28" }, { slot: 1, task });
  return { fill, asked };
}

// Runs `expression` in the page's tab, e.g. to move focus.
async function inPage(browser: string, expression: string) {
  const page = (await targets(browser)).find((t) => t.type === "page")!;
  const tab = await devtools(browser, page);
  await tab.send("Runtime.evaluate", { expression });
  tab.close();
}

test.skipIf(!existsSync(CHROME))("asks once per entry per task: not again for the card's other fields, again for a new task or entry", async () => {
  const page = await chrome(9351, `data:text/html,${encodeURIComponent('<input aria-label="Card" autofocus>')}`);
  close.push(page.close);
  const { fill, asked } = await vaultFill(page.url);

  await fill("Card", ["number"], 7);
  await fill("Card", ["expiry"], 7);
  await fill("Card", ["cvc"], 7);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain('A yes covers the rest of this task\'s typing of "Card" there');

  await fill("Card", ["cvc"], 8);
  await fill("Login", ["password"], 8);
  expect(asked).toHaveLength(3);
});

test.skipIf(!existsSync(CHROME))("a no covers nothing, and without a task number every fill asks", async () => {
  const page = await chrome(9352, `data:text/html,${encodeURIComponent('<input aria-label="Card" autofocus>')}`);
  close.push(page.close);
  let yes = false;
  const { fill, asked } = await vaultFill(page.url, () => yes);

  expect(JSON.stringify(await fill("Card", ["number"], 7))).toContain("declined");
  yes = true;
  await fill("Card", ["number"], 7);
  await fill("Card", ["cvc"]);
  await fill("Card", ["cvc"]);

  expect(asked).toHaveLength(4);
  expect(asked[2]).not.toContain("A yes covers");
});

test.skipIf(!existsSync(CHROME))("a yes for the card's frame covers the page's own fields; a yes for the page doesn't cover the frame", async () => {
  // One server reached as two sites, so the page frames the other site's card form.
  const server = createServer((req, res) =>
    res.writeHead(200, { "Content-Type": "text/html" }).end(req.url === "/card" ? '<input aria-label="Number">' : `<input aria-label="Name"><iframe src="http://localhost:${port}/card"></iframe>`),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  close.push(() => server.close());
  const page = await chrome(9353, `http://127.0.0.1:${port}/`);
  close.push(page.close);
  await new Promise((r) => setTimeout(r, 1500));
  const { fill, asked } = await vaultFill(page.url);
  const [frame, top] = ['document.querySelector("iframe").focus()', 'document.querySelector("input").focus()'];

  await inPage(page.url, frame);
  await fill("Card", ["number"], 7);
  await inPage(page.url, top);
  await fill("Card", ["expiry"], 7);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(`127.0.0.1:${port}, in a frame from localhost:${port}`);

  await inPage(page.url, top);
  await fill("Card", ["expiry"], 8);
  await inPage(page.url, frame);
  await fill("Card", ["number"], 8);
  expect(asked).toHaveLength(3);
});
