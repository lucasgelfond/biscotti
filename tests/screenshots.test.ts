import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import screenshots from "../plugins/screenshots/index.ts";
import { CHROME, chrome, testContext } from "./support.ts";

test.skipIf(!existsSync(CHROME))("texts the owner a screenshot of the task's browser with its caption, each time it's asked", { timeout: 60_000 }, async () => {
  const page = await chrome(9480, "data:text/html,<h1>2BR on Atlantic Ave</h1>");
  process.env.TASK_BROWSER = page.url;
  const texts: { text: string; image?: Buffer }[] = [];
  const tools = await screenshots.tools!(testContext({ send: async (text, image) => void texts.push({ text, image }) }));

  await tools.tasks!.call("share_screenshot", { caption: "2BR on Atlantic Ave, $3,400" }, { slot: 1 });
  await tools.tasks!.call("share_screenshot", { caption: "Studio on Dean St, $2,600" }, { slot: 1 });
  page.close();
  delete process.env.TASK_BROWSER;

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  expect(texts.map((t) => t.text)).toEqual(["2BR on Atlantic Ave, $3,400", "Studio on Dean St, $2,600"]);
  expect(texts.every((t) => t.image?.subarray(0, 4).equals(PNG))).toBe(true);
});
