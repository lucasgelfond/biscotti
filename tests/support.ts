import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../core/src/biscotti.ts";
import type { Plugin } from "../core/src/plugin.ts";

// Starts biscotti as main.ts does, with the named plugins and a stand-in for the owner's phone: `say` is the owner
// texting (resolving once biscotti has replied), `sent` is everything biscotti texted back.

export const newDataDir = () => mkdtempSync(join(tmpdir(), "biscotti-"));

// Plugins by name (as in biscotti.json) or, for a test's own, the plugin itself.
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

// The tools the agent called, in order, from the saved transcript.
export function toolCalls(db: Awaited<ReturnType<typeof boot>>["db"]) {
  return db.$client
    .prepare("SELECT entry FROM transcripts")
    .all()
    .map((r) => JSON.parse((r as { entry: string }).entry))
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .map((e) => (e.message.content as { type: string; name?: string }[]).flatMap((c) => (c.type === "toolCall" ? [c.name!] : [])));
}
