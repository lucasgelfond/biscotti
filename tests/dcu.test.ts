import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { jev, writer } from "../plugins/discriminative-computer-use/index.ts";
import { browse } from "../plugins/discriminative-computer-use/loop.ts";
import { newDataDir } from "./support.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES: Record<string, string> = {
  "/": `<h1>Mug Shop</h1><input type="password" aria-label="Password"><ul><li><a href="/red">Red Mug</a></li><li><a href="/blue">Blue Mug</a></li></ul>`,
  "/red": `<h1>Red Mug</h1><p>Price: $9.00</p>`,
  "/blue": `<h1>Blue Mug</h1><p>Price: $12.50</p><p>In stock</p>`,
};

test.skipIf(!existsSync(CHROME) || !process.env.TYPESAFE_API_KEY)("finds a price a click away, deciding each step with Jev", { timeout: 120_000 }, async () => {
  const shop = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(PAGES[req.url ?? ""] ?? "")).listen(0, "127.0.0.1");
  await new Promise((r) => shop.once("listening", r));
  const port = 9460;
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${newDataDir()}`, "about:blank"], { stdio: "ignore" });
  const browser = `http://127.0.0.1:${port}`;
  await expect.poll(() => fetch(`${browser}/json/version`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
  const env = (name: string) => process.env[name]!;

  const result = await browse("Find the price of the Blue Mug.", browser, { decide: jev(env("TYPESAFE_API_KEY")), write: writer({ env }) }, `http://127.0.0.1:${(shop.address() as AddressInfo).port}/`);
  chrome.kill();
  shop.close();

  expect(result.outcome).toBe("done");
  expect(result.steps.join("\n")).toContain('click <a> "Blue Mug"');
  expect(result.report).toContain("12.50");
});
