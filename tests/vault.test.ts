import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { openDb } from "../core/src/memory.ts";
import type { Plugin } from "../core/src/plugin.ts";
import { vault as vaultTable } from "../core/src/schema.ts";
import vault, { fill, newPassword, totp } from "../core/src/vault.ts";
import { boot, newDataDir, toolCalls } from "./support.ts";

const biscotti = boot([]);

const formLink = (sent: string[]) => sent.join("\n").match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/)?.[0];

test("saves a login through a one-time form, and shows the agent its username but not its password", async () => {
  const { say, sent, db, dir } = await biscotti;

  await say("I want to save my Delta login so you can book flights. Send me the form.");
  const link = formLink(sent)!;
  const page = await (await fetch(link)).text();
  // The agent names the fields; the password goes in the one that says so, the username in the rest.
  const fields = [...page.matchAll(/name="(f:[^"]+)"/g)].map((m) => m[1]);
  const values = fields.map((f) => [f, /pass/i.test(f) ? "hunter2-biscotti" : "owner@example.com"]);
  const saved = await fetch(link, { method: "POST", body: new URLSearchParams(values) });
  const reused = await fetch(link);
  // Saving tells the agent, which replies; wait for that before asking.
  const before = sent.length;
  await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(before);
  await say("Look up my Delta login and tell me the username and the password.");

  const onDisk = readFileSync(`${dir}/biscotti.db`);
  const texts = sent.join("\n");
  expect(fields.some((f) => /pass/i.test(f))).toBe(true);
  expect(saved.status).toBe(200);
  expect(reused.status).toBe(404);
  expect(onDisk.includes("hunter2")).toBe(false);
  expect(toolCalls(db).flat()).toContain("mcp__biscotti__vault_list");
  expect(texts).toContain("owner@example.com");
  expect(texts).not.toContain("hunter2-biscotti");
});

test("saves a password pasted in chat, and from then on the model only sees a placeholder for it", async () => {
  const { say, sent, db } = await boot([]);

  await say("Save my Netflix login to the vault: username ada@example.com, password correct-horse-9.");
  sent.length = 0;
  await say("What's my Netflix password? Spell it out exactly.");

  const saved = db.$client.prepare("SELECT value FROM vault WHERE name LIKE '%etflix%'").get() as { value: string } | undefined;
  expect(toolCalls(db).flat()).toContain("mcp__biscotti__vault_save");
  expect(saved?.value).toContain("correct-horse-9");
  expect(sent.join("\n")).not.toContain("correct-horse-9");
});

test.for([
  [59_000, "287082"],
  [1_111_111_109_000, "081804"],
  [1_234_567_890_000, "005924"],
] as const)("computes the RFC 6238 authenticator code at %i", ([now, code]) => {
  const setup = "otpauth://totp/Example:ada?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example";

  const result = totp(setup, now);

  expect(result).toBe(code);
});

// A headless Chrome showing `html`, its DevTools at the returned URL. Each input's value is mirrored into the title.
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
async function chrome(html: string, port: number) {
  const mirror = `<script>onchange = oninput = () => document.title = [...document.querySelectorAll("input, select")].map((e) => e.value).join("|")</script>`;
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${newDataDir()}`, `data:text/html,${encodeURIComponent(html + mirror)}`], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  await expect.poll(() => fetch(`${url}/json/version`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
  const title = async () => ((await (await fetch(`${url}/json/list`)).json()) as { type: string; title: string }[]).find((t) => t.type === "page")!.title;
  return { url, title, close: () => proc.kill() };
}

test.skipIf(!existsSync(CHROME))("types a login and a card's expiry month into the page, and says where, not what", async () => {
  const page = await chrome(`<input aria-label="Email" autofocus value="old@example.com"><input type="password" aria-label="Password">
<select aria-label="Month"><option>01</option><option>07</option><option>12</option></select>`, 9341);

  const into = await fill(page.url, () => ["ada@example.com", "hunter2-biscotti", "7"]);
  const title = await page.title();
  page.close();

  expect(into).toEqual(['input[text] "Email"', 'input[password] "Password"', 'select[select-one] "Month"']);
  expect(title).toBe("ada@example.com|hunter2-biscotti|07");
});

test.skipIf(!existsSync(CHROME))("refuses to type when no input is focused", async () => {
  const page = await chrome(`<input aria-label="Email">`, 9342);

  const filled = fill(page.url, () => ["hunter2-biscotti"]);

  await expect(filled).rejects.toThrow("click the input first");
  page.close();
});

// One server, reached as two sites (127.0.0.1 and localhost), so a page can frame the other site. `pages` gets the
// frame site's URL.
async function sites(pages: (frame: string) => Record<string, string>) {
  let routes: Record<string, string> = {};
  const server = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(routes[req.url!] ?? "")).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  routes = pages(`http://localhost:${port}`);
  return { page: `127.0.0.1:${port}`, frame: `localhost:${port}`, close: () => server.close() };
}

// A headless Chrome on `url`, given a moment for its frames to load and take focus.
async function chromeAt(url: string, port: number) {
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${newDataDir()}`, url], { stdio: "ignore" });
  const devtools = `http://127.0.0.1:${port}`;
  await expect.poll(() => fetch(`${devtools}/json/version`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
  await new Promise((r) => setTimeout(r, 1500));
  return { url: devtools, close: () => proc.kill() };
}

test.skipIf(!existsSync(CHROME))("asks with the site typing would go to, naming a frame's own site, and types nothing on a no", async () => {
  const server = await sites((frame) => ({
    "/": `<input aria-label="Card"><iframe src="${frame}/card"></iframe><script>document.querySelector("iframe").onload = (e) => e.target.focus()</script>`,
    "/card": "<input>",
  }));
  const page = await chromeAt(`http://${server.page}/`, 9343);
  const asked: string[] = [];

  const into = await fill(page.url, () => ["4111111111111111"], async (where) => (asked.push(where), false));
  page.close();
  server.close();

  expect(asked).toEqual([`${server.page}, in a frame from ${server.frame}`]);
  expect(into).toBeUndefined();
});

test.skipIf(!existsSync(CHROME))("stops when focus moves to another site after the approval", async () => {
  const server = await sites((frame) => ({ "/": `<input aria-label="Email" autofocus><iframe src="${frame}/other"></iframe>`, "/other": "<input>" }));
  const page = await chromeAt(`http://${server.page}/`, 9344);
  const asked: string[] = [];

  const filled = fill(page.url, () => ["ada@example.com", "hunter2-biscotti"], async (where) => (asked.push(where), true));

  await expect(filled).rejects.toThrow(`Stopped after 1 field(s): typing would now go to ${server.page}, in a frame from ${server.frame}`);
  expect(asked).toEqual([server.page]);
  page.close();
  server.close();
});

test.for([0, 1, 2, 3, 4])("makes a new password with both cases and a digit, in three groups of six (%i)", () => {
  const password = newPassword();

  expect(password).toMatch(/^[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/);
  expect(password).toMatch(/[a-z]/);
  expect(password).toMatch(/[A-Z]/);
  expect(password).toMatch(/\d/);
});

test.skipIf(!existsSync(CHROME))("sets a new password into the page and the vault, keeps the old one, and never shows it", async () => {
  const page = await chrome(`<input type="password" aria-label="New password" autofocus><input type="password" aria-label="Confirm password">`, 9345);
  process.env.TASK_BROWSER = page.url;
  const dir = newDataDir();
  const db = openDb(`${dir}/biscotti.db`, "test-key");
  db.insert(vaultTable).values({ name: "Delta login", fields: ["username", "password"], value: { username: "ada@example.com", password: "old-password-1" } }).run();
  const asked: string[] = [];
  const ctx = { db, dir, env: (n: string) => n, ask: async (q: string) => (asked.push(q), true), deliver: async () => {} };
  const tools = await vault.tools!(ctx);

  const result = await tools.tasks!.call("vault_new_password", { name: "Delta login", why: "the old one expired", confirm: true }, { slot: 1 });
  const typed = (await page.title()).split("|");
  page.close();
  delete process.env.TASK_BROWSER;
  const saved = db.select().from(vaultTable).all()[0].value;
  const said = JSON.stringify(result) + asked.join("\n");

  expect(typed).toEqual([saved.password, saved.password]);
  expect(saved.password).not.toBe("old-password-1");
  expect(saved["previous password"]).toBe("old-password-1");
  expect(saved.username).toBe("ada@example.com");
  expect(asked[0]).toContain('set a new password for "Delta login"');
  expect(said).not.toContain(saved.password);
});

test("never texts a saved secret, whoever wrote the text", async () => {
  const leaky: Plugin = {
    async start(ctx) {
      ctx.db.insert(vaultTable).values({ name: "Delta login", fields: ["password"], value: { password: "hunter2-biscotti" } }).run();
      void ctx.ask("Is the Delta password still hunter2-biscotti?");
    },
  };
  const { sent } = await boot([leaky]);

  await expect.poll(() => sent.length).toBeGreaterThan(0);

  expect(sent[0]).toContain("[vault:Delta login.password]");
  expect(sent.join("\n")).not.toContain("hunter2-biscotti");
});
