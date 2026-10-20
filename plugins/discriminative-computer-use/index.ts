import { readFileSync } from "node:fs";
import { input, localTools, optional, str, text, type Plugin } from "@biscotti/core";

// Website errands driven by TypeSafe's Jev, a decision model that picks each action from the page's options in a
// fraction of a second, instead of an LLM reading every page. The loop runs in a task VM beside its browser
// (vm.ts); the gate only answers its decisions, so the key stays here.

const API = process.env.TYPESAFE_URL ?? "https://api.typesafe.ai";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";

// What the VM runs, sent with each errand.
const RUNNER = Object.fromEntries(
  [["main.ts", "vm.ts"], ["loop.ts", "loop.ts"], ["page.ts", "page.ts"]].map(([as, file]) => [as, readFileSync(new URL(file, import.meta.url), "utf8")]),
);

export function jev(key: string) {
  return async (state: object, questions: object) => {
    const res = await fetch(`${API}/v1/systemone`, {
      signal: AbortSignal.timeout(30_000),
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
    });
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).answers;
  };
}

export default {
  prompt: `Quick browsing: \`browse\` does an errand on a website (look something up, run a site search, log in with
a saved login and check something) fast and cheaply. Use \`task\` for anything that needs judgment across pages:
comparing options, seat maps and other pictures, several sites, or when browse comes back unsure.`,

  async tools(ctx) {
    if (!ctx.task || !process.env.TYPESAFE_API_KEY) return localTools([]);
    const decide = jev(ctx.env("TYPESAFE_API_KEY"));
    return {
      ...localTools([
        {
          name: "browse",
          description:
            "Do an errand on a website in a fresh VM's browser: a fast decision model clicks through it step by step, and saved logins are filled from the vault (the owner approves each). Returns at once; a 'Browse report' message follows, usually within a minute.",
          input: input({
            goal: str("Complete on its own, e.g. 'On news.ycombinator.com, find the top story and its points'."),
            url: optional(str("Where to start, if known.")),
          }),
          async run({ goal, url }) {
            const errand = String(goal);
            void ctx
              .task!(JSON.stringify({ goal: errand, url }), { runner: RUNNER, timeoutMs: 10 * 60_000 })
              .then(({ report, screenshot }) => ctx.deliver(`Browse report (${errand}): ${report}`, screenshot))
              .catch((err: Error) => ctx.deliver(`Browse report (${errand}): browsing failed: ${err.message}`));
            return text("Browsing.");
          },
        },
      ]),
      // For the runner in the VM.
      tasks: localTools([
        {
          name: "jev_decide",
          description: "Internal to browse: one Jev decision. Other task agents don't need it.",
          input: input({ state: { type: "object" }, questions: { type: "object" } }),
          run: async ({ state, questions }) => text(JSON.stringify(await decide(state as object, questions as object))),
        },
      ]),
    };
  },
} satisfies Plugin;
