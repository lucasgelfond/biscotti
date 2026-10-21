import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../core/src/agent.ts";
import { start } from "../core/src/biscotti.ts";
import { openDb } from "../core/src/memory.ts";
import type { Context, Plugin } from "../core/src/plugin.ts";
import { asTexts, tapbacks } from "../plugins/channels/spectrum/index.ts";

// biscotti as main.ts starts it, with a stand-in phone that splits texts and takes tapbacks as iMessage does: `say`
// texts it (resolving once it replied), `sent` is its texts.

export const newDataDir = () => mkdtempSync(join(tmpdir(), "biscotti-"));

// A plugin's context with no gate behind it: every question is a yes unless `ask` says otherwise.
export function testContext(overrides: Partial<Context> = {}): Context {
  const dir = newDataDir();
  return { db: openDb(`${dir}/biscotti.db`, "test-key"), dir, env: (n) => n, ask: async () => true, deliver: async () => {}, send: async () => {}, ...overrides };
}

// A headless Chrome showing `url`, its DevTools at the returned `url` once it's up.
export const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export async function chrome(port: number, url: string, args: string[] = []) {
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${newDataDir()}`, ...args, url], { stdio: "ignore" });
  const devtools = `http://127.0.0.1:${port}`;
  while (!(await fetch(`${devtools}/json/version`).then((r) => r.ok, () => false))) await new Promise((r) => setTimeout(r, 100));
  return { url: devtools, close: () => proc.kill() };
}

// With `restart` (an earlier boot), a new gate over its data and sockets, as after the service restarts: its agent
// keeps running.
export async function boot(names: (string | Plugin)[], dir = newDataDir(), restart?: { sockets: string; gateUrl: string }) {
  const sent: string[] = [];
  const images: Buffer[] = [];
  const reactions: string[] = [];
  const tapback = tapbacks();
  const phone: Plugin = {
    channel: async () => ({
      messages: (async function* () {})(),
      send: async (m) => void ("text" in m ? sent.push(...asTexts(m.text)) : images.push(m.image)),
    }),
    tools: async () => tapback.tools,
  };
  const plugins = await Promise.all(
    names.map(async (name) => (typeof name === "string" ? ((await import(/* @vite-ignore */ new URL(`../plugins/${name}/index.ts`, import.meta.url).href)).default as Plugin) : name)),
  );
  // The agent as in production, reaching the gate only through the sockets; its relay is the tests' way in too.
  const sockets = restart?.sockets ?? mkdtempSync(join(tmpdir(), "sockets-"));
  const biscotti = await start({ plugins: [phone, ...plugins], dir, sockets });
  const gateUrl = restart?.gateUrl ?? (await runAgent(sockets, join(dir, "agent"))).gateUrl;
  const say = (text: string) => {
    tapback.seen({ react: async (emoji) => void reactions.push(emoji) });
    return biscotti.handle({ text });
  };
  return { ...biscotti, gateUrl, dir, sockets, say, sent, images, reactions };
}


export function toolCalls(db: Awaited<ReturnType<typeof boot>>["db"]) {
  return db.$client
    .prepare("SELECT entry FROM transcripts")
    .all()
    .map((r) => JSON.parse((r as { entry: string }).entry))
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .map((e) => (e.message.content as { type: string; name?: string }[]).flatMap((c) => (c.type === "toolCall" ? [c.name!] : [])));
}
