import { expect, test } from "vitest";
import { boot, toolCalls } from "./support.ts";

const hasToken = !!process.env.GITHUB_TOKEN;

test.skipIf(!hasToken)("reads from GitHub without asking", async () => {
  const { say, sent, db } = await boot(["github"]);

  await say("What's my GitHub username? Look it up.");

  expect(toolCalls(db).flat().length).toBeGreaterThan(0);
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

test("a VM whose pull request was merged or closed is deleted; one whose pull request is open stays", async () => {
  const { createServer } = await import("node:http");
  const { cleanUp } = await import("../plugins/github/index.ts");
  const states: Record<string, { state: string; merged_at: string | null }> = {
    "/repos/o/r/pulls/1": { state: "closed", merged_at: "2026-11-15T00:00:00Z" },
    "/repos/o/r/pulls/2": { state: "open", merged_at: null },
    "/repos/o/r/pulls/3": { state: "closed", merged_at: null },
  };
  const api = createServer((req, res) => res.end(JSON.stringify(states[req.url!]))).listen(0, "127.0.0.1");
  await new Promise((r) => api.once("listening", r));
  const removed: number[] = [];
  const alive = [1, 2, 3].map((n) => ({ id: 40 + n, goal: "fix", asleep: true, used: 0, pr: `https://github.com/o/r/pull/${n}` }));
  const ctx = { db: undefined, vms: { alive: () => [...alive, { id: 50, goal: "box", asleep: false, used: 0 }], remove: async (id: number) => (removed.push(id), true) } };
  process.env.GITHUB_TOKEN ??= "t";
  await cleanUp(ctx as never, ctx.vms as never, `http://127.0.0.1:${(api.address() as { port: number }).port}`);
  api.close();
  expect(removed).toEqual([41, 43]);
});
