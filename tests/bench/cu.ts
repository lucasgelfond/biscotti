// Computer-use benchmark: EverydayBench's tasks (everydaybench.ts) in task VMs, per model and guidance, with timings and tool counts.
// On the Pi, with the live agent stopped and EverydayBench up:  node tests/bench/cu.ts <model> <guidance> [task…]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGate } from "../../core/src/gate.ts";
import { openDb } from "../../core/src/memory.ts";
import type { Context, Plugin } from "../../core/src/plugin.ts";
import { restore, SLOTS } from "../../core/src/tasks.ts";
import vault from "../../core/src/vault.ts";
import { RUNNER } from "../../plugins/jev-quick-browse/index.ts";
import { observer, otlp, tracerFor } from "../../plugins/phoenix/index.ts";
import { everydayBenchLogins, everydayBenchTasks, type Task } from "./everydaybench.ts";
import { read, report } from "./report.ts";
import type { Observer } from "../../core/src/plugin.ts";

const VM_DIR = process.env.VM_DIR ?? "/var/lib/biscotti/vm";
const FIRECRACKER = process.env.FIRECRACKER ?? "/usr/local/bin/firecracker";
const OUT = process.env.OUT ?? "/tmp/cu";

const GUIDANCE: Record<string, string> = {
  none: "",
  // quick_browse for whole stretches, and its account trusted: fewer turns of the agent's own.
  qbh: `Quick browsing: quick_browse is a fast decision model that clicks and types through a site in seconds, and it is
your main way to move around websites. Hand it whole stretches of a task in one call, not single clicks: "on the ticket site,
open tomorrow's showtimes for Primetime near Brooklyn and list the theaters and times", "search the store for headphones
between $24 and $100 and open the cheapest", "fill in the booking form and stop at the payment page". Give it every piece
of text it should type as \`values\` (e.g. {"name": "Ada Lovelace", "date": "2025-09-29"}). It reports which of its
requirements it met and what the page shows: trust that report and go on from it; don't take your own snapshot to
re-check unless it says something is unmet or you're about to do something consequential (order, pay, book, send),
which you do yourself after checking the page. If it fails twice at the same stretch, do that stretch yourself.`,
  // quick_browse made prominent, as a line of the task prompt would.
  qb: `Quick browsing: hand plain navigation to quick_browse, a fast decision model that clicks through a site in seconds:
getting from a home page to a listing, running a site's search, picking a date or a theater, opening a product, showtime
or seat selection. Give it one concrete sub-goal at a time, with any text it should type as \`values\` (e.g. {"name": "Ada Lovelace"}), then
check the page yourself (a snapshot) before going on.
Do judgment calls, reading results, filling forms with given details and anything consequential (ordering, sending)
yourself.`,
  shots: `How to work the desktop:
- Take a screenshot first and after every action that changes the page, and look at it before deciding the next step. Trust the screenshot over your assumptions.
- For web pages, prefer reading the page's text or accessibility tree to find elements, then click them; fall back to coordinates from the latest screenshot.
- Batch obvious steps (click a field, type, press Tab) without a screenshot between each, then check with one screenshot.
- If something didn't change as expected, take a screenshot, figure out why, and try another way instead of repeating the same action.`,
};

type Record_ = { type: string; data?: string; toolName?: string; isError?: boolean; durationMs?: number; message?: { role: string; content: { type: string; text?: string }[] } };

// A task's setup in the VM's browser, which can hang (DevTools has no timeouts of its own).
const within = <T>(work: Promise<T> | undefined, what: string) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took over 2 minutes`)), 120_000).unref())]);

// Each run's number, for the gate (a slot's run starts with nothing told).
let runs = 0;
// Every line the VM sent, for the trace file.
async function run(task: string, slot: number, guidance: string) {
  const started = Date.now();
  const lines: string[] = [];
  phoenix?.start(slot);
  usage.set(slot, { llmCalls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
  const vm = await restore(VM_DIR, FIRECRACKER, slot, 1100 + slot);
  const restored = Date.now() - started;
  const tools: Record<string, number> = {};
  let errors = 0;
  let toolMs = 0;
  let turns = 0;
  let report = "";
  let screenshot: Buffer | undefined;
  const browser = `http://10.200.${slot}.2:9223`;
  let lastEvent = 0;
  let t: Task | undefined;
  // The owner's mid-run texts, as tell_task would pass them: through the gate to this slot's VM.
  const followups: { text: string; atSeconds: number }[] = [];
  let polling: ReturnType<typeof setInterval> | undefined;
  gate.assign(slot, ++runs);
  try {
    t = await TASKS[task]!();
    gate.assign(slot, runs, t.goal);
    await within(t.setup?.(browser), "setup");
    polling = setInterval(() => {
      void t!.followups?.().then((due) => {
        for (const { text } of due) {
          gate.tell(slot, text);
          followups.push({ text, atSeconds: Math.round((Date.now() - started) / 1000) });
        }
      });
    }, 3000);
    const goal = guidance ? `${t.goal}\n\n${guidance}` : t.goal;
    await new Promise<void>((resolve, reject) => {
      // CU_JEV: the errand goes to Jev's runner instead of pi.
      const sent = process.env.CU_JEV ? { goal: JSON.stringify({ goal }), runner: RUNNER } : { goal, context: Number(process.env.CU_CONTEXT) || undefined, lean: Number(process.env.CU_LEAN) || undefined, oversee: Boolean(process.env.CU_OVERSEE) };
      const socket = connect({ host: `10.200.${slot}.2`, port: 4000 }, () => socket.end(JSON.stringify(sent)));
      socket.setTimeout(10 * 60_000, () => socket.destroy(new Error(`timed out; the VM's last event came at ${lastEvent}s`)));
      // A connection that died without a word errors out instead of waiting for the timeout.
      socket.setKeepAlive(true, 30_000);
      createInterface({ input: socket }).on("line", (line) => {
        lastEvent = Math.round((Date.now() - started) / 1000);
        const e = JSON.parse(line) as Record_ & { png?: string };
        // Not the streamed partial messages: each repeats the message so far (most of a trace's size), and message_end has it.
        if (e.type !== "message_update") lines.push(line);
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
      })
        // A timeout reaches the line reader too: without this it'd end the whole bench.
        .on("error", reject);
      socket.on("error", reject).on("close", () => resolve());
    });
  } catch (err) {
    report ||= `failed: ${(err as Error).message}`;
  } finally {
    clearInterval(polling);
    gate.assign(slot);
    await vm.stop();
  }
  const seconds = (Date.now() - started) / 1000;
  // Jev's runner ends a run it didn't finish with this.
  const pass = !/goal not done/i.test(report) && Boolean(t && (await t.pass(report).catch(() => false)));
  const graded = t?.graded === undefined ? undefined : JSON.stringify(t.graded, null, 2);
  return { task, pass, progress: t?.graded?.progress, ...(followups.length && { followups }), lastEvent, seconds, restoredMs: restored, turns, toolSeconds: toolMs / 1000, errors, tools, ...usage.get(slot), report, screenshot, lines, graded };
}

const [model, guide = "none", ...only] = process.argv.slice(2);
// CU_LLM_URL and CU_LLM_KEY: another provider for the task model (e.g. H Company's, for Holo).
// CU_RPM: at most that many model calls a minute (a provider's rate limit, e.g. Holo's 10 on H Company's free tier),
// through a local relay that spaces them out and tries again on a 429. Times then say little; tokens and passes still do.
async function relay(target: string, rpm: number) {
  let next = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    for (let tries = 0; ; tries++) {
      const wait = Math.max(0, next - Date.now());
      next = Math.max(Date.now(), next) + 60_000 / rpm;
      await new Promise((r) => setTimeout(r, wait));
      const up = await fetch(`${target.replace(/\/$/, "")}${req.url}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: req.headers.authorization ?? "" }, body: Buffer.concat(chunks) });
      if (up.status === 429 && tries < 5) continue;
      res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/json" });
      for await (const c of up.body ?? []) res.write(c);
      return void res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const upstream = process.env.CU_LLM_URL || process.env.LLM_BASE_URL!;
const gate = createGate({ llm: { url: process.env.CU_RPM ? await relay(upstream, Number(process.env.CU_RPM)) : upstream, key: process.env.CU_LLM_KEY || process.env.LLM_API_KEY!, region: process.env.CU_LLM_URL ? undefined : process.env.LLM_REGION || undefined }, models: { task: model }, send: async () => {} });
// Each run's model calls and tokens (a streamed reply reports its usage in its last chunk).
const usage = new Map<number, { llmCalls: number; promptTokens: number; completionTokens: number; cachedTokens: number; toolCount?: number; toolChars?: number; systemChars?: number }>();
gate.observe({
  llm: ({ slot, request }) => ({ body }) => {
    const u = slot === undefined ? undefined : usage.get(slot);
    if (!u) return;
    // What every call carries, from the first: the tool definitions and the system prompt (in characters, ~4 a token).
    if (!u.llmCalls) {
      const messages = request.messages as { role: string; content: unknown }[];
      Object.assign(u, { toolCount: (request.tools as unknown[] | undefined)?.length ?? 0, toolChars: JSON.stringify(request.tools ?? []).length, systemChars: JSON.stringify(messages.filter((m) => m.role === "system" || m.role === "developer")).length });
    }
    u.llmCalls++;
    u.promptTokens += Number([...body.matchAll(/"prompt_tokens":\s*(\d+)/g)].at(-1)?.[1] ?? 0);
    u.completionTokens += Number([...body.matchAll(/"completion_tokens":\s*(\d+)/g)].at(-1)?.[1] ?? 0);
    u.cachedTokens += Number([...body.matchAll(/"cached_tokens":\s*(\d+)/g)].at(-1)?.[1] ?? 0);
  },
});
// CU_PHOENIX: the gate's model and tool calls to Phoenix, a project per label, a fresh task trace per run.
const phoenix = process.env.CU_PHOENIX ? (() => {
  const { tracer, provider } = tracerFor(otlp(), `bench ${process.env.CU_LABEL ?? model}`);
  const current = new Map<number, Observer>();
  const none = () => () => {};
  gate.observe({
    llm: (call) => (call.slot !== undefined && current.get(call.slot)?.llm?.(call)) || none(),
    tool: (call) => (call.slot !== undefined && current.get(call.slot)?.tool?.(call)) || none(),
  });
  return { start: (slot: number) => current.set(slot, observer(tracer)), flush: () => provider.forceFlush() };
})() : undefined;
// The vault (empty; CU_DB keeps the database across runs, e.g. for lessons), and plugins whose task tools the VMs get, e.g. CU_PLUGINS=secure-fill,vision,jev-quick-browse.
const scratch = mkdtempSync(join(tmpdir(), "cu-"));
// The owner says yes to whatever a task asks (a vault fill on a site): what is graded is what the task does with it.
const ctx: Context = { db: openDb(process.env.CU_DB ?? `${scratch}/biscotti.db`, "bench"), dir: scratch, env: (n) => process.env[n] ?? "", ask: async () => true, deliver: async () => {}, send: async () => {}, task: async () => ({ report: "" }) };
gate.add(await vault.tools!(ctx));
for (const name of (process.env.CU_PLUGINS ?? "").split(",").filter(Boolean)) {
  const plugin: Plugin = (await import(`../../plugins/${name}/index.ts`)).default;
  if (plugin.tools) gate.add(await plugin.tools(ctx));
}
const servers = await Promise.all(SLOTS.map((slot) => gate.listen(`10.200.${slot}.1`, 80, { slot })));
const TASKS = await everydayBenchTasks(ctx.db);
const tasks = only.length ? only : Object.keys(TASKS);
const dir = `${OUT}/${model.replace("/", "_")}-${guide}${process.env.CU_LABEL ? `-${process.env.CU_LABEL}` : ""}`;
mkdirSync(dir, { recursive: true });

const queue = [...tasks];
const results: Awaited<ReturnType<typeof run>>[] = [];
// A page to watch the bench by (index.html in OUT, refreshing itself): what's running and where to see its screen
// (CU_SCREENS, the address whose port 10440 + slot shows that slot's VM), then the report so far.
const running = new Map<number, { task: string; started: number }>();
// Never stops the bench: it's only for watching.
function page() {
  try {
    write();
  } catch (err) {
    console.error("the watch page:", err);
  }
}
function write() {
  const now = [...running].map(([slot, r]) => `- ${r.task}, ${Math.round((Date.now() - r.started) / 1000)}s in${process.env.CU_SCREENS ? ` ([screen](${process.env.CU_SCREENS}:${10440 + slot}))` : ""}`);
  const soFar = existsSync(`${OUT}/results.jsonl`) ? report(read(`${OUT}/results.jsonl`), true) : "";
  const md = `Setup **${process.env.CU_LABEL ?? model}**, ${queue.length} tasks queued. Running now:\n\n${now.join("\n") || "nothing"}\n\n${soFar}`;
  writeFileSync(
    `${OUT}/index.html`,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="20"><title>Benchmark</title>
<style>body{font:14px/1.5 ui-monospace,Menlo,monospace;max-width:1200px;margin:24px auto;padding:0 16px;background:#fff;color:#000}table{border-collapse:collapse;display:block;overflow-x:auto}td,th{border:1px solid #ccc;padding:2px 6px;white-space:nowrap}a{color:#2400ff}</style>
<div id="r"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script><script>r.innerHTML = marked.parse(${JSON.stringify(md).replace(/</g, "\\u003c")})</script>`,
  );
}
// The next task whose logins no running task has (the vault is shared), or none left; waits while all clash.
const LOGINS = await everydayBenchLogins();
const inUse = new Set<string>();
async function next() {
  while (queue.length) {
    const i = queue.findIndex((t) => !(LOGINS[t] ?? []).some((l) => inUse.has(l)));
    if (i >= 0) {
      const [task] = queue.splice(i, 1);
      for (const l of LOGINS[task!] ?? []) inUse.add(l);
      return task;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await Promise.all(
  SLOTS.map(async (slot) => {
    for (let task = await next(); task; task = await next()) {
      running.set(slot, { task, started: Date.now() });
      page();
      const result = await run(task, slot, GUIDANCE[guide]);
      running.delete(slot);
      for (const l of LOGINS[task] ?? []) inUse.delete(l);
      const name = `${task.replaceAll("/", "__")}${process.env.CU_RUN ? `-r${process.env.CU_RUN}` : ""}`;
      if (result.screenshot) writeFileSync(`${dir}/${name}.png`, result.screenshot);
      writeFileSync(`${dir}/${name}.jsonl`, `${result.lines.join("\n")}\n`);
      if (result.graded) writeFileSync(`${dir}/${name}.grade.json`, result.graded);
      const { screenshot: _, lines: __, graded: ___, ...line } = result;
      const json = JSON.stringify({ model, guide, label: process.env.CU_LABEL, run: process.env.CU_RUN, ...line });
      console.log(json);
      appendFileSync(`${OUT}/results.jsonl`, `${json}\n`);
      results.push(result);
      page();
    }
  }),
);
const passed = results.filter((r) => r.pass).length;
const mean = results.reduce((s, r) => s + r.seconds, 0) / results.length;
console.log(`SUMMARY ${model} ${guide}: ${passed}/${results.length} passed, mean ${mean.toFixed(1)} s`);
for (const s of servers) s.close();
await phoenix?.flush();
process.exit(0);
