import { existsSync, readFileSync, rmSync } from "node:fs";
import { start } from "./biscotti.ts";
import type { Plugin } from "./plugin.ts";

const config = JSON.parse(readFileSync(new URL("../../biscotti.json", import.meta.url), "utf8"));
const plugins: Plugin[] = await Promise.all(
  (config.plugins as string[]).map(async (name) => (await import(`../../plugins/${name}/index.ts`)).default),
);

const dir = process.env.DATA_DIR ?? "/data";
// The gate; the main agent runs in its own container (agent-main.ts), sharing only BISCOTTI_SOCKETS.
const { channel, handle } = await start({ plugins, dir, sockets: process.env.BISCOTTI_SOCKETS ?? "/run/biscotti" });
// Setup leaves a first text for the owner, sent once biscotti can answer.
if (existsSync(`${dir}/welcome`)) {
  await channel.send({ text: readFileSync(`${dir}/welcome`, "utf8").trim() });
  rmSync(`${dir}/welcome`);
}
// Not awaited: a message mid-reply steers it.
for await (const message of channel.messages) void handle(message);
