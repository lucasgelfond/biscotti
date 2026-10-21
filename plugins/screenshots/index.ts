import { input, localTools, str, text, type Plugin } from "@biscotti/core";
import { browser, devtools, targets } from "../secure-fill/index.ts";

// Task VMs show the owner what they see as they go: a screenshot of the VM's browser, texted straight into the thread
// with a caption, as often as it helps (each listing, the seat map). The gate takes it, so the VM sends no image.

// A task's worth: at most this many per VM slot in half an hour.
const MAX_PER_TASK = 12;
const WINDOW_MS = 30 * 60_000;

async function capture(url: string) {
  const page = (await targets(url)).find((t) => t.type === "page");
  if (!page) throw new Error("no browser tab is open");
  const tab = await devtools(url, page);
  try {
    return Buffer.from((await tab.send("Page.captureScreenshot", { format: "png" })).data, "base64");
  } finally {
    tab.close();
  }
}

export default {
  prompt: `Screenshots: a task can text the user screenshots as it goes (\`share_screenshot\`). When they want to see
several things (listings, options, a seat map), say so in the task's goal, e.g. "share a screenshot of each listing".`,

  async tools(ctx) {
    const sent = new Map<number, number[]>();
    return {
      ...localTools([]),
      tasks: localTools([
        {
          name: "share_screenshot",
          description: `Text the requester a screenshot of the browser as it is now, with a short caption: for each listing, option or seat map they'd want to see. Up to ${MAX_PER_TASK} per task.`,
          input: input({ caption: str("What it shows, e.g. '2BR on Atlantic Ave, $3,400'.") }),
          async run({ caption }, { slot = 0 }) {
            const recent = (sent.get(slot) ?? []).filter((t) => t > Date.now() - WINDOW_MS);
            if (recent.length >= MAX_PER_TASK) return text(`That's ${MAX_PER_TASK} already; put the rest in the report.`);
            await ctx.send(String(caption).slice(0, 300), await capture(browser(slot)));
            sent.set(slot, [...recent, Date.now()]);
            return text("Sent.");
          },
        },
      ]),
    };
  },
} satisfies Plugin;
