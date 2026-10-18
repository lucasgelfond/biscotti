import { expect, test } from "vitest";
import { boot, toolCalls } from "./support.ts";

const hasToken = !!process.env.GITHUB_TOKEN;

test.skipIf(!hasToken)("reads from GitHub without asking", async () => {
  const { say, sent, db } = await boot(["github"]);

  await say("What's my GitHub username? Look it up.");

  expect(toolCalls(db).flat().some((n) => n.startsWith("mcp__biscotti__"))).toBe(true);
  expect(sent.join("\n")).not.toContain("Reply yes or no");
  expect(sent.join("\n").toLowerCase()).toContain("lucasgelfond");
});

test.skipIf(!hasToken)("asks before a change, and makes none on a no", async () => {
  const { say, sent } = await boot(["github"]);

  const replied = say("Open an issue on lucasgelfond/biscotti titled 'test from biscotti' with an empty body. Go ahead.");
  await expect.poll(() => sent.join("\n"), { timeout: 90_000 }).toContain("Reply yes or no");
  await say("no");
  await replied;

  expect(sent).toContain("Declined.");
});
