import { expect, test } from "vitest";
import { boot, toolCalls } from "./support.ts";

// Exa's hosted MCP server with the owner's key, through the gate.
const hasKey = !!process.env.EXA_API_KEY;

test.skipIf(!hasKey)("answers a question that needs the web with Exa", async () => {
  const biscotti = await boot(["exa"]);

  await biscotti.say("Search the web: what's the latest Firecracker release on GitHub? Answer with just the version.");

  expect(toolCalls(biscotti.db).flat().some((name) => name.endsWith("_exa"))).toBe(true);
  expect(biscotti.sent.join("\n")).toMatch(/v?1\.\d+/);
});

test.skipIf(!hasKey)("looks up independent things in parallel, in one turn", async () => {
  const biscotti = await boot(["exa"]);

  await biscotti.say("What are today's opening hours of the Louvre and of the British Museum?");

  const searchesPerTurn = toolCalls(biscotti.db).map((names) => names.filter((n) => n.endsWith("_exa")).length);
  expect(Math.max(...searchesPerTurn)).toBeGreaterThanOrEqual(2);
});
