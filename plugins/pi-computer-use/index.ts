import { readFileSync } from "node:fs";
import { input, localTools, str, text, type Plugin } from "@biscotti/core";

// injaneity's pi-computer-use (github.com/injaneity/pi-computer-use) in a task VM: pi gets its tools (observe, search
// and act, each action checked for whether it worked) over the VM's Chromium and desktop, in place of Playwright's
// and Cua's. vm.ts fetches the package per task, pinned by npm's hash.

const RUNNER = { "main.ts": readFileSync(new URL("vm.ts", import.meta.url), "utf8") };

export default {
  prompt: `Computer use, checked: \`computer_task\` is like \`task\`, but its agent works through pi-computer-use, whose
actions report whether they worked. Prefer it for forms and desktop apps where clicks silently fail.`,

  async tools(ctx) {
    if (!ctx.task) return localTools([]);
    return localTools([
      {
        name: "computer_task",
        description: "Like task, in a fresh VM, with pi-computer-use's checked actions. Returns at once; a 'Computer task report' message follows.",
        input: input({ goal: str("Complete on its own: the agent sees only this.") }),
        async run({ goal }) {
          const errand = String(goal);
          void ctx
            .task!(errand, { runner: RUNNER })
            .then(({ report, screenshot }) => ctx.deliver(`Computer task report (${errand}): ${report}`, screenshot))
            .catch((err: Error) => ctx.deliver(`Computer task report (${errand}): it failed: ${err.message}`));
          return text("Started.");
        },
      },
    ]);
  },
} satisfies Plugin;
