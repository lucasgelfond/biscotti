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

test.skipIf(!hasToken)("asks before a deletion, and makes none on a no", async () => {
  const { say, sent } = await boot(["github"]);

  // Deleting asks even on a repo the user just named: it's what their yes is for.
  const replied = say("Delete README.md from lucasgelfond/biscotti on its main branch (the GitHub delete_file tool). Go ahead.");
  await expect.poll(() => sent.join("\n"), { timeout: 90_000 }).toContain("Reply yes or no");
  await say("no");
  await replied;

  expect(sent).toContain("Declined.");
});
