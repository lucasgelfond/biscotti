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

test.skipIf(!hasToken)("asks before closing something, and closes nothing on a no", async () => {
  const { say, sent } = await boot(["github"]);

  const replied = say("Close pull request #78 on lucasgelfond/biscotti. Go ahead.");
  await expect.poll(() => sent.join("\n"), { timeout: 90_000 }).toContain("Reply yes or no");
  await say("no");
  await replied;

  expect(sent).toContain("Declined.");
});
