import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { saveSecret } from "../core/src/plugin.ts";
import { devtools, targets } from "../plugins/secure-fill/index.ts";
import vision from "../plugins/vision/index.ts";
import { CHROME, chrome, testContext } from "./support.ts";

const PAGE = `data:text/html,<body style="margin:0"><button style="position:absolute;left:600px;top:300px;width:100px;height:40px">Seat F12</button><input id="pw" type="password"></body>`;

// A grounding endpoint answering (500, 500) of 1000: the middle of the page. It keeps what it was sent.
async function grounder() {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: '{"x": 500, "y": 500}' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

afterEach(() => {
  for (const name of ["TASK_BROWSER", "GROUNDING_URL", "GROUNDING_API_KEY"]) delete process.env[name];
});

test.skipIf(!existsSync(CHROME))("zooms into a region of the page as an image", { timeout: 60_000 }, async () => {
  const page = await chrome(9490, PAGE, ["--window-size=1280,720"]);
  process.env.TASK_BROWSER = page.url;
  const tools = await vision.tools!(testContext());

  const result = await tools.tasks!.call("zoom", { region: [600, 300, 700, 340] }, { slot: 1 });
  page.close();

  const PNG_BASE64 = /^iVBORw0KGgo/;
  expect(result.content).toEqual([
    { type: "image", mimeType: "image/png", data: expect.stringMatching(PNG_BASE64) },
    { type: "text", text: "The region (600,300)-(700,340), 4.0x." },
  ]);
});

test.skipIf(!existsSync(CHROME))("locates by description: sends only the screenshot and the target, and answers in page coordinates", { timeout: 60_000 }, async () => {
  const page = await chrome(9491, PAGE, ["--window-size=1280,720"]);
  const holo = await grounder();
  Object.assign(process.env, { TASK_BROWSER: page.url, GROUNDING_URL: holo.url, GROUNDING_API_KEY: "test" });
  const tools = await vision.tools!(testContext());

  const result = await tools.tasks!.call("locate", { target: "seat F12" }, { slot: 1 });
  page.close();
  holo.close();

  const [sent] = holo.requests;
  const parts = sent.messages[0].content.map((p: { type: string }) => p.type);
  expect(sent.messages).toHaveLength(1);
  expect(parts).toEqual(["image_url", "text"]);
  expect(sent.messages[0].content[1].text).toMatch(/Your target is: seat F12$/);
  expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^\d+, \d+ \(in a \d+x\d+ page\)/) }]);
});

test.skipIf(!existsSync(CHROME))("won't send the page out while a saved secret is typed into it", { timeout: 60_000 }, async () => {
  const page = await chrome(9492, PAGE);
  const holo = await grounder();
  Object.assign(process.env, { TASK_BROWSER: page.url, GROUNDING_URL: holo.url, GROUNDING_API_KEY: "test" });
  const ctx = testContext();
  saveSecret(ctx.db, "Delta login", { username: "ada", password: "hunter2-very-secret" });
  const tools = await vision.tools!(ctx);
  const tab = await devtools(page.url, (await targets(page.url)).find((t) => t.type === "page")!);
  await tab.send("Runtime.evaluate", { expression: `document.getElementById("pw").value = "hunter2-very-secret"` });
  tab.close();

  const result = await tools.tasks!.call("locate", { target: "seat F12" }, { slot: 1 });
  page.close();
  holo.close();

  expect(result.content).toEqual([{ type: "text", text: "Not while a saved secret is in the page. Use the page snapshot instead." }]);
  expect(holo.requests).toHaveLength(0);
});

test("without a grounding key, task VMs get zoom alone", async () => {
  const tools = await vision.tools!(testContext());

  const names = (await tools.tasks!.list()).map((t) => t.name);

  expect(names).toEqual(["zoom"]);
});
