import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../core/src/biscotti.ts";
import type { Plugin } from "../core/src/plugin.ts";

// biscotti as main.ts starts it, with a stand-in phone: `say` texts it (resolving once it replied), `sent` is its texts.

export const newDataDir = () => mkdtempSync(join(tmpdir(), "biscotti-"));

export async function boot(names: (string | Plugin)[], dir = newDataDir()) {
  const sent: string[] = [];
  const images: Buffer[] = [];
  const reactions: string[] = [];
  const phone: Plugin = {
    channel: async () => ({
      messages: (async function* () {})(),
      send: async (m) => void ("text" in m ? sent.push(m.text) : images.push(m.image)),
    }),
  };
  const plugins = await Promise.all(
    names.map(async (name) => (typeof name === "string" ? ((await import(/* @vite-ignore */ new URL(`../plugins/${name}/index.ts`, import.meta.url).href)).default as Plugin) : name)),
  );
  const biscotti = await start({ plugins: [phone, ...plugins], dir });
  const say = (text: string) => biscotti.handle({ text, react: async (emoji) => void reactions.push(emoji) });
  return { ...biscotti, dir, say, sent, images, reactions };
}

export function toolCalls(db: Awaited<ReturnType<typeof boot>>["db"]) {
  return db.$client
    .prepare("SELECT entry FROM transcripts")
    .all()
    .map((r) => JSON.parse((r as { entry: string }).entry))
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .map((e) => (e.message.content as { type: string; name?: string }[]).flatMap((c) => (c.type === "toolCall" ? [c.name!] : [])));
}
