// Computer-use benchmark: real web tasks in task VMs, per model and guidance, with timings and tool counts.
// On the Pi, with the live agent stopped:  node tests/bench/cu.ts <model> <guidance> [task…]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { createGate } from "../../core/src/gate.ts";
import { restore, SLOTS } from "../../core/src/tasks.ts";

const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const OUT = process.env.OUT ?? "/tmp/cu";

const TASKS: Record<string, { goal: string; pass: (report: string) => boolean | Promise<boolean> }> = {
  hn: {
    goal: "Open https://news.ycombinator.com and report the exact title of the #1 story.",
    async pass(report) {
      const [id] = await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json();
      const { title } = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json();
      return report.toLowerCase().includes(title.toLowerCase().slice(0, 25));
    },
  },
  sauce: {
    goal: "On https://www.saucedemo.com log in as standard_user with password secret_sauce, add the Sauce Labs Backpack to the cart, check out as Ada Lovelace, zip 10001, and finish the order. Report the confirmation message.",
    pass: (r) => /thank you for your order/i.test(r),
  },
  demoblaze: {
    goal: "On https://www.demoblaze.com buy one Samsung galaxy s6: add it to the cart, then Place Order with name Ada Lovelace, country USA, city New York, card 4242424242424242, month 12, year 2030, and Purchase. Report the confirmation exactly as shown, including the amount and card number.",
    pass: (r) => /thank you for your purchase/i.test(r) && r.replace(/\D/g, "").includes("4242424242424242"),
  },
  flights: {
    goal: "Look up nonstop and one-stop flights from JFK to SFO on November 14, 2026, departing in the morning (before noon), on Google Flights. Report the best few options with airline, departure and arrival times, stops and price. Leave the results on screen.",
    pass: (r) => /\$\s?\d/.test(r) && /(am|a\.m\.|\d{1,2}:\d{2})/i.test(r) && !/(couldn't|could not|unable to)/i.test(r),
  },
  "cameron-village": {
    goal: "Starting at https://www.angelikafilmcenter.com/villageeast, find the next showing of the concert film \"Cameron Winter at Carnegie Hall\", open its seat selection, and give a general overview of the seat map: which areas are open, roughly how full, and the best 2 seats together left (for 2 people). Leave the seat map on screen. Don't buy anything.",
    pass: (r) => /seat/i.test(r) && !/(couldn't|could not|unable to) (find|get|open)/i.test(r),
  },
  "cameron-bam": {
    goal: "Starting at https://www.bam.org/film/2026/cameron-winter, find the next showing of the concert film \"Cameron Winter at Carnegie Hall\" at BAM Rose Cinemas and its seating: if seats are reserved, open seat selection and give a general overview of the seat map (which areas are open, roughly how full, the best 2 seats together left); if it's general admission, say so with the showtimes. Don't buy anything.",
    pass: (r) => /seat/i.test(r) && !/(couldn't|could not|unable to) (find|get|open)/i.test(r),
  },
  angelika: {
    goal: "Find tickets for the Cameron Winter concert film at an Angelika theater in New York. Pick the next showing, open its seat selection, and give a general overview of the seat map: which areas are open, roughly how full, and the best seats left. Leave the seat map on screen. Don't buy anything.",
    pass: (r) => /cameron winter/i.test(r) && /seat/i.test(r) && !/(couldn't|could not|unable to) (find|get|open)/i.test(r),
  },
  seats: {
    goal: "Open https://www.aerolopa.com/dl-321 (Delta A321 seat map) and give a general overview of the seat map: the cabins, roughly how many rows each, and which rows are exit rows.",
    pass: (r) => /first|comfort/i.test(r) && /exit/i.test(r),
  },
};

const GUIDANCE: Record<string, string> = {
  none: "",
  shots: `How to work the desktop:
- Take a screenshot first and after every action that changes the page, and look at it before deciding the next step. Trust the screenshot over your assumptions.
- For web pages, prefer reading the page's text or accessibility tree to find elements, then click them; fall back to coordinates from the latest screenshot.
- Batch obvious steps (click a field, type, press Tab) without a screenshot between each, then check with one screenshot.
- If something didn't change as expected, take a screenshot, figure out why, and try another way instead of repeating the same action.`,
};

type Record_ = { type: string; toolName?: string; isError?: boolean; durationMs?: number; message?: { role: string; content: { type: string; text?: string }[] } };

async function run(task: string, slot: number, guidance: string) {
  const started = Date.now();
  const vm = await restore(VM_DIR, FIRECRACKER, slot, 1100 + slot);
  const restored = Date.now() - started;
  const tools: Record<string, number> = {};
  let errors = 0;
  let toolMs = 0;
  let turns = 0;
  let report = "";
  let screenshot: Buffer | undefined;
  try {
    const goal = guidance ? `${TASKS[task].goal}\n\n${guidance}` : TASKS[task].goal;
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: `10.200.${slot}.2`, port: 4000 }, () => socket.end(goal));
      socket.setTimeout(10 * 60_000, () => socket.destroy(new Error("timed out")));
      createInterface({ input: socket }).on("line", (line) => {
        const e = JSON.parse(line) as Record_ & { png?: string };
        if (process.env.CU_TRACE && e.type.startsWith("tool_execution_") && e.type !== "tool_execution_update")
          console.error(`${((Date.now() - started) / 1000).toFixed(1)}s ${task} ${e.type.slice(15)} ${e.toolName} ${e.isError ? "ERROR" : ""} ${e.type.endsWith("start") ? JSON.stringify((e as { args?: unknown }).args ?? "").slice(0, 160) : ""}`);
        if (e.type === "screenshot") screenshot = Buffer.from(e.png!, "base64");
        if (e.type === "turn_start") turns++;
        if (process.env.CU_TRACE && ["turn_start", "message_end", "agent_settled"].includes(e.type))
          console.error(`${((Date.now() - started) / 1000).toFixed(1)}s ${task} ${e.type} ${e.message?.role ?? ""}`);
        if (e.type === "tool_execution_end") {
          tools[e.toolName!] = (tools[e.toolName!] ?? 0) + 1;
          if (e.isError) errors++;
          toolMs += e.durationMs ?? 0;
        }
        if (e.type === "message_end" && e.message?.role === "assistant") {
          const err = (e.message as { errorMessage?: string }).errorMessage;
          if (err) report = `error: ${err}`;
          const text = e.message.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
          if (text) report = text;
        }
      });
      socket.on("error", reject).on("close", () => resolve());
    });
  } catch (err) {
    report ||= `failed: ${(err as Error).message}`;
  } finally {
    await vm.stop();
  }
  const seconds = (Date.now() - started) / 1000;
  const pass = await TASKS[task].pass(report);
  return { task, pass, seconds, restoredMs: restored, turns, toolSeconds: toolMs / 1000, errors, tools, report: report.slice(0, 400), screenshot };
}

const [model, guide = "none", ...only] = process.argv.slice(2);
const gate = createGate({ llm: { url: process.env.LLM_BASE_URL!, key: process.env.LLM_API_KEY! }, models: { task: model }, send: async () => {} });
const servers = await Promise.all(SLOTS.map((slot) => gate.listen(`10.200.${slot}.1`, 80, { slot })));
const tasks = only.length ? only : Object.keys(TASKS);
const dir = `${OUT}/${model.replace("/", "_")}-${guide}`;
mkdirSync(dir, { recursive: true });

const queue = [...tasks];
const results: Awaited<ReturnType<typeof run>>[] = [];
await Promise.all(
  SLOTS.map(async (slot) => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      const result = await run(task, slot, GUIDANCE[guide]);
      if (result.screenshot) writeFileSync(`${dir}/${task}.png`, result.screenshot);
      const { screenshot: _, ...line } = result;
      const json = JSON.stringify({ model, guide, ...line });
      console.log(json);
      appendFileSync(`${OUT}/results.jsonl`, `${json}\n`);
      results.push(result);
    }
  }),
);
const passed = results.filter((r) => r.pass).length;
const mean = results.reduce((s, r) => s + r.seconds, 0) / results.length;
console.log(`SUMMARY ${model} ${guide}: ${passed}/${results.length} passed, mean ${mean.toFixed(1)} s`);
for (const s of servers) s.close();
process.exit(0);
