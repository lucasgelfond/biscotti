import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { localTools, text, type Plugin } from "../core/src/plugin.ts";
import { boot } from "./support.ts";

// Core stands on its own: no plugin is needed but a channel, and a plugin from outside the repo plugs in the same way.
// No model is called, so stand-in settings will do.
for (const [name, value] of Object.entries({ LLM_BASE_URL: "http://127.0.0.1:9", LLM_API_KEY: "unused", MODEL: "m", TASK_MODEL: "m", DB_KEY: "k" })) process.env[name] ??= value;

const root = new URL("..", import.meta.url).pathname;

async function toolNames(gateUrl: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateUrl}/mcp`)));
  return (await client.listTools()).tools.map((t) => t.name);
}

test("core typechecks with none of plugins/ in the program", () => {
  const dir = mkdtempSync(join(tmpdir(), "core-only-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.json"), include: [join(root, "core/src")], compilerOptions: { noEmit: true } }));
  const tsc = join(root, "node_modules/.bin/tsc");

  const out = execFileSync(tsc, ["-p", join(dir, "tsconfig.json"), "--listFilesOnly"], { encoding: "utf8" });

  expect(out.split("\n").filter((f) => f.includes("/plugins/"))).toEqual([]);
  execFileSync(tsc, ["-p", join(dir, "tsconfig.json")]);
});

test("boots with no plugins (the test phone is the channel): only core's own tools", async () => {
  const { gateUrl } = await boot([]);

  const names = await toolNames(gateUrl);

  expect(names).toEqual(expect.arrayContaining(["vault_list", "remember", "recall"]));
  expect(names.some((n) => /exa|gmail|github|artifact/.test(n))).toBe(false);
});

test("a plugin that isn't in plugins/ gets the same API", async () => {
  const mine: Plugin = { tools: async () => localTools([{ name: "my_tool", description: "Mine.", input: { type: "object" }, run: async () => text("ok") }]) };
  const { gateUrl } = await boot([mine]);

  expect(await toolNames(gateUrl)).toContain("my_tool");
});
