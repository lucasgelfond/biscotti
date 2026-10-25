import { existsSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import vision from "../plugins/vision/index.ts";
import { CHROME, chrome } from "./support.ts";

const PAGE = `data:text/html,<body style="margin:0"><button style="position:absolute;left:600px;top:300px;width:100px;height:40px">Seat F12</button></body>`;

afterEach(() => {
  delete process.env.TASK_BROWSER;
});

test.skipIf(!existsSync(CHROME))("zooms into a region of the page as an image", { timeout: 60_000 }, async () => {
  const page = await chrome(9490, PAGE, ["--window-size=1280,720"]);
  process.env.TASK_BROWSER = page.url;
  const tools = await vision.tools!();

  const result = await tools.tasks!.call("zoom", { region: [600, 300, 700, 340] }, { slot: 1 });
  page.close();

  const PNG_BASE64 = /^iVBORw0KGgo/;
  expect(result.content).toEqual([
    { type: "image", mimeType: "image/png", data: expect.stringMatching(PNG_BASE64) },
    { type: "text", text: "The region (600,300)-(700,340), 4.0x." },
  ]);
});

test("task VMs get zoom", async () => {
  const tools = await vision.tools!();

  const names = (await tools.tasks!.list()).map((t) => t.name);

  expect(names).toEqual(["zoom"]);
});
