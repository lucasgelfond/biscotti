import { existsSync, readFileSync, rmSync } from "node:fs";
import { start } from "./biscotti.ts";
import type { Plugin } from "./plugin.ts";

const GATE_PORT = 4790;
const config = JSON.parse(readFileSync(process.env.BISCOTTI_CONFIG ?? new URL("../../biscotti.json", import.meta.url), "utf8"));
const plugins: Plugin[] = await Promise.all(
  (config.plugins as string[]).map(async (name) => (await import(`../../plugins/${name}/index.ts`)).default),
);

const dir = process.env.DATA_DIR ?? "/data";
const { channel, handle } = await start({ plugins, dir, gatePort: GATE_PORT });
// Setup leaves a first text for the owner, sent once biscotti can answer.
if (existsSync(`${dir}/welcome`)) {
  await channel.send({ text: readFileSync(`${dir}/welcome`, "utf8").trim() });
  rmSync(`${dir}/welcome`);
}
// Not awaited: a message mid-reply steers it.
for await (const message of channel.messages) void handle(message);
