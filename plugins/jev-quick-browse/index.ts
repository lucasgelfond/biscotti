import { readFileSync } from "node:fs";
import { input, localTools, optional, secrets, str, text, type Plugin } from "@biscotti/core";
import { browser } from "../secure-fill/index.ts";
import { browse } from "./loop.ts";

// Website errands driven by TypeSafe's Jev, a decision model that picks each action from the page's options in a
// fraction of a second, instead of an LLM reading every page. The loop runs in a task VM beside its browser
// (vm.ts); the gate only answers its decisions, so the key stays here.

const API = process.env.TYPESAFE_URL ?? "https://api.typesafe.ai";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";
const IMAGE_MODEL = process.env.TYPESAFE_IMAGE_MODEL ?? "jev-preview";

// What the VM runs, sent with each errand.
export const RUNNER = Object.fromEntries(
  [["main.ts", "vm.ts"], ["loop.ts", "loop.ts"], ["page.ts", "page.ts"]].map(([as, file]) => [as, readFileSync(new URL(file, import.meta.url), "utf8")]),
);

// With `assets` (screenshots, by the names state refers to them by), on the model that reads images and boxes. A rate
// limit or overload (429, 529, 503) is asked again after a growing pause, as TypeSafe's SDKs do; a request over the
// model's context (400 max_tokens_exceeded) comes back as an error the loop shrinks its request for.
export function jev(key: string) {
  return async (state: object, questions: object, assets?: object) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}/v1/systemone`, {
        signal: AbortSignal.timeout(30_000),
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(assets && { "TypeSafe-Danger-Zone-Images": "true" }) },
        body: JSON.stringify({ model: assets ? IMAGE_MODEL : MODEL, state, questions, ...(assets && { assets }) }),
      });
      if ([429, 503, 529].includes(res.status) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).answers;
    }
  };
}

// The requirements an errand set itself, as a report's last lines.
export const checklist = (requirements: { requirement: string; met: boolean }[] = []) =>
  requirements.length ? `\nRequirements:\n${requirements.map((r) => `- ${r.met ? "met" : "NOT met"}: ${r.requirement}`).join("\n")}` : "";
const VALUES = { type: "object", additionalProperties: str(), description: "Text to type, by what it's for, e.g. { \"destination city\": \"Boston\", \"check-in date\": \"Nov 3\" }. Never passwords or card details: those come from the vault." };

// The writing model for quick_browse, through the gate as the slot's VM reaches it, so its secrets are kept out the
// same way.
const writer = (slot?: number) => async (instructions: string, packet: object) => {
  const res = await fetch(`${process.env.TASK_GATE ?? `http://10.200.${slot}.1`}/llm/chat/completions`, {
    signal: AbortSignal.timeout(120_000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "task", messages: [{ role: "system", content: instructions }, { role: "user", content: JSON.stringify(packet) }] }),
  });
  if (!res.ok) throw new Error(`the writing model: ${res.status}`);
  return String((await res.json()).choices[0].message.content ?? "").trim();
};

export default {
  prompt: `Quick browsing: \`browse\` does an errand on a website (look something up, run a site search, log in with
a saved login and check something) fast and cheaply. Use \`task\` for anything that needs judgment across pages:
comparing options across pages, several sites, or when browse comes back unsure. Browse can pick seats on a seat map.`,

  async tools(ctx) {
    if (!ctx.task || !process.env.TYPESAFE_API_KEY) return localTools([]);
    const decide = jev(process.env.TYPESAFE_API_KEY);
    return {
      ...localTools([
        {
          name: "browse",
          description:
            "Do an errand on a website in a fresh VM's browser: a fast decision model clicks through it step by step, and saved logins are filled from the vault (the owner approves each). Returns at once; a 'Browse report' message follows, usually within a minute.",
          input: input({
            goal: str("Complete on its own, e.g. 'On news.ycombinator.com, find the top story and its points'."),
            url: optional(str("Where to start, if known.")),
            values: optional(VALUES),
          }),
          async run({ goal, url, values }) {
            const errand = String(goal);
            void ctx
              .task!(JSON.stringify({ goal: errand, url, values }), { runner: RUNNER, timeoutMs: 10 * 60_000 })
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
          input: input({ state: { type: "object" }, questions: { type: "object" }, assets: optional({ type: "object" }) }),
          run: async ({ state, questions, assets }) => text(JSON.stringify(await decide(state as object, questions as object, assets as object | undefined))),
        },
        {
          name: "quick_browse",
          description:
            "Hand a run of plain browsing steps on the current page (navigate a site, open a listing, pick a date, find a showtime, fill a search form) to a fast decision model that clicks through them in seconds. Give it one concrete sub-goal, and the text to type in `values`; it plans checkable requirements, works through them, and returns what the page shows, which requirements are met, and why it stopped. It only completes a purchase, booking, message or deletion when the goal says to. Check the page after, and do judgment calls and vault fills yourself.",
          input: input({
            goal: str("One concrete sub-goal on this site, e.g. 'open the 7:40 PM showing of Anora and get to seat selection'."),
            url: optional(str("A URL to open first, if not the current page.")),
            values: optional(VALUES),
            constraints: optional(str("What must hold along the way, e.g. 'nonstop only; don't go past the review page'.")),
          }),
          async run({ goal, url, values, constraints }, { slot }) {
            const page = browser(slot);
            const steps: string[] = [];
            const vaulted = secrets(ctx.db).map((s) => s.value);
            const result = await browse(constraints ? `${goal}\nConstraints: ${constraints}` : String(goal), page, {
              decide,
              write: writer(slot),
              log: (line) => steps.push(line),
              values: (values ?? {}) as Record<string, string>,
              redact: vaulted,
            }, url ? String(url) : undefined).catch((err: Error) => ({ report: `Browsing failed: ${err.message}`, outcome: "error", steps: [] as string[], requirements: [] }));
            return text(`${result.report}\n(${result.outcome}, ${result.steps.length} steps)${checklist(result.requirements)}\nSteps:\n${steps.slice(-15).join("\n")}`);
          },
        },
      ]),
    };
  },
} satisfies Plugin;
