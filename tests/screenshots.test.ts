import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { openDb } from "../core/src/memory.ts";
import screenshots from "../plugins/screenshots/index.ts";
import { newDataDir } from "./support.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test.skipIf(!existsSync(CHROME))("texts the owner a screenshot of the task's browser with its caption, each time it's asked", { timeout: 60_000 }, async () => {
  const port = 9480;
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${newDataDir()}`, "data:text/html,<h1>2BR on Atlantic Ave</h1>"], { stdio: "ignore" });
  process.env.TASK_BROWSER = `http://127.0.0.1:${port}`;
  await expect.poll(() => fetch(`${process.env.TASK_BROWSER}/json/version`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
  const dir = newDataDir();
  const texts: { text: string; image?: Buffer }[] = [];
  const ctx = { db: openDb(`${dir}/biscotti.db`, "k"), dir, env: (n: string) => n, ask: async () => true, deliver: async () => {}, send: async (text: string, image?: Buffer) => void texts.push({ text, image }) };
  const tools = await screenshots.tools!(ctx);

  await tools.tasks!.call("share_screenshot", { caption: "2BR on Atlantic Ave, $3,400" }, { slot: 1 });
  await tools.tasks!.call("share_screenshot", { caption: "Studio on Dean St, $2,600" }, { slot: 1 });
  chrome.kill();
  delete process.env.TASK_BROWSER;

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  expect(texts.map((t) => t.text)).toEqual(["2BR on Atlantic Ave, $3,400", "Studio on Dean St, $2,600"]);
  expect(texts.every((t) => t.image?.subarray(0, 4).equals(PNG))).toBe(true);
});
