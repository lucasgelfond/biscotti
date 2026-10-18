import { readFileSync } from "node:fs";
import { start } from "./biscotti.ts";
import type { Plugin } from "./plugin.ts";

// Starts biscotti with the plugins biscotti.json names, and answers the owner's messages.

const GATE_PORT = 4790;
const config = JSON.parse(readFileSync(process.env.BISCOTTI_CONFIG ?? new URL("../../biscotti.json", import.meta.url), "utf8"));
const plugins: Plugin[] = await Promise.all(
  (config.plugins as string[]).map(async (name) => (await import(`../../plugins/${name}/index.ts`)).default),
);

const { channel, handle } = await start({ plugins, dir: process.env.DATA_DIR ?? "/data", gatePort: GATE_PORT });
// Not awaited: a message that arrives mid-reply steers the reply already underway.
for await (const message of channel.messages) void handle(message);
