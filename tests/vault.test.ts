import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { fill, totp } from "../core/src/vault.ts";
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

  const into = await fill(page.url, ["ada@example.com", "hunter2-biscotti", "7"]);
  const title = await page.title();
  page.close();

  expect(into).toEqual(['input[text] "Email"', 'input[password] "Password"', 'select[select-one] "Month"']);
  expect(title).toBe("ada@example.com|hunter2-biscotti|07");
});

test.skipIf(!existsSync(CHROME))("refuses to type when no input is focused", async () => {
  const page = await chrome(`<input aria-label="Email">`, 9342);

  const filled = fill(page.url, ["hunter2-biscotti"]);

  await expect(filled).rejects.toThrow("click the input first");
  page.close();
});
