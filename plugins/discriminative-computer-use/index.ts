import { input, localTools, optional, str, text, type Context, type Plugin } from "@biscotti/core";
import { browse, type Decide, type Write } from "./loop.ts";

// Quick website errands in a task VM's browser, driven by TypeSafe's Jev, a decision model that picks each action
// from the page's options in a fraction of a second, instead of the task agent's LLM reading every page. The LLM only
// writes what to type, which site to open, and the report.

const API = process.env.TYPESAFE_URL ?? "https://api.typesafe.ai";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";

export function jev(key: string): Decide {
  return async (state, questions) => {
    const res = await fetch(`${API}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
    });
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).answers;
  };
}

export function writer(ctx: Pick<Context, "env">): Write {
  return async (instructions, packet) => {
    const res = await fetch(`${ctx.env("LLM_BASE_URL")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.env("LLM_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.env("TASK_MODEL"),
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: JSON.stringify(packet) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`the writing model: ${res.status}`);
    return String((await res.json()).choices[0].message.content ?? "").trim();
  };
}

export default {
  prompt: `Quick browsing: \`browse\` does a simple errand on one website (look something up, open a page, run a site
search) fast and cheaply. Use \`task\` for anything harder: logins, checkouts, forms, several sites, or when browse
comes back unsure.`,

  async tools(ctx) {
    if (!ctx.vm || !process.env.TYPESAFE_API_KEY) return localTools([]);
    const tools = { decide: jev(ctx.env("TYPESAFE_API_KEY")), write: writer(ctx) };
    return localTools([
      {
        name: "browse",
        description:
          "Do a simple errand on a website in a fresh VM's browser: a fast decision model clicks through it step by step. Good for lookups and navigation; no logins or payments. Returns at once; a 'Browse report' message follows, usually within a minute.",
        input: input({
          goal: str("Complete on its own, e.g. 'On news.ycombinator.com, find the top story and its points'."),
          url: optional(str("Where to start, if known.")),
        }),
        async run({ goal, url }) {
          const errand = String(goal);
          void ctx
            .vm!(async (browser) => {
              const { report, outcome, steps } = await browse(errand, browser, tools, url ? String(url) : undefined);
              return `${report}\n(${outcome}, ${steps.length} steps)`;
            })
            .catch((err: Error) => `Browsing failed: ${err.message}`)
            .then((report) => ctx.deliver(`Browse report (${errand}): ${report}`));
          return text("Browsing.");
        },
      },
    ]);
  },
} satisfies Plugin;
