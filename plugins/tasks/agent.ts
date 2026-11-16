import { readFileSync } from "node:fs";
import { type AgentApi, type AgentPart, asTools, gateMcp, type Message, textOf } from "@biscotti/core/agent";
import { type Conversation, type ConversationId, type Extension, defineDoc, defineExtension, GenerationTask, hook, LiveDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, openProcess, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { McpClient, PipeTransport } from "@earendil-works/pi-mcp";
import { inputFrom } from "pi-durable-ahp";
import { chats } from "./chats.ts";
import type { TaskRun } from "./types.ts";

// The tasks plugin's side in the main agent's process: each task a conversation of its own whose tools work in the
// task's VM, which the gate holds and sets up (index.ts). The shell and files are pi-env's daemon in the VM, reached
// through the gate (env-pipe.ts, vm-env.ts); the browser is Playwright's MCP server, run in the VM the same way; the
// gate's task tools (the vault, sharing a screenshot, lessons) are that VM's. The gate asks for a run (tasks/run) and
// gets its report, a screenshot of the final screen, and what the run collects (a coding task's commits). Its model
// calls go through the gate like the main agent's. Its tasks and VMs are chats beside the session that started them
// (chats.ts).

const DISPLAY = { DISPLAY: ":1" };
// How long one tool call may run before the task may count as gone quiet all the same.
const TOOL_QUIET_MAX_MS = 30 * 60_000;
// Tools whose results are views of the page.
const VIEW = /browser_(snapshot|take_screenshot)|zoom/;
// The latest views kept whole; older ones become a note, five at a time, so the start of the conversation stays the
// same between batches and the provider's prompt cache keeps working.
const LATEST = 2;
const STEP = 5;
const NOTE = "(An earlier view of the page, left out to keep the conversation short. Take a snapshot or screenshot to see the page now.)";
// The browser tools a task gets, of Playwright's: the rest (rarer ones) are left out.
const BROWSER = new Set(
  ["navigate", "navigate_back", "snapshot", "click", "type", "fill_form", "select_option", "press_key", "run_code_unsafe", "evaluate", "take_screenshot", "find", "mouse_click_xy", "mouse_wheel", "tabs", "handle_dialog", "wait_for", "file_upload"].map((t) => `browser_${t}`),
);
const PLAYWRIGHT = ["playwright-mcp", "--cdp-endpoint", "http://127.0.0.1:9222", "--caps", "vision", "--snapshot-mode", "none"];

// A task's instructions; a plugin may add to them (TaskRun.instructions).
const PROMPT = readFileSync(new URL("./TASK.md", import.meta.url), "utf8");

// The desktop's shape for a task the owner watches from their phone: portrait and phone-sized, so sites lay out as
// they do on a phone. Chromium is maximized to fill it.
const SHAPES: Record<string, string> = { mobile: "432x936" };

// Each task's conversation (by its number), and the runs under way (by task, its conversation), to settle after a restart.
const Tasks = defineDoc<{ ids: Record<string, string>; running?: Record<string, string> }>({ kind: "biscotti.tasks", version: 1, scope: "session", initial: () => ({ ids: {} }), checkpointWhen: () => true });
// A task's number (its VM's), and whether its last run was cut off (it went quiet, ran out of time or was stopped).
const TaskDoc = defineDoc<{ id: number; interrupted?: boolean }>({
  kind: "biscotti.task",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: 0 }),
  checkpointWhen: () => false,
});

type Part = { type: string; text?: string; id?: string; name?: string };
const partsOf = (m: Message): Part[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Part[]));
type McpTool = Parameters<typeof asTools>[0][number];

export default function tasks(api: AgentApi): AgentPart {
  const { ctx, link } = api;
  const getHarness = () => api.harness();
  const gate = gateMcp(api.call);
  // pi-env's daemon in VM `id`, through the gate (env-pipe.ts): the command its `Connection` starts.
  const daemon = (id: number) => [process.execPath, new URL("./env-pipe.ts", import.meta.url).pathname, api.sockets, String(id)];
  // A task conversation's record changed; a run under way here (`cid`) or over (none).
  const mark = (cid: ConversationId, patch: { interrupted?: boolean }) => getHarness().commit(async (tx) => void Object.assign(await tx.doc(TaskDoc, cid), patch), ctx);
  const underway = (id: number, cid?: ConversationId) =>
    getHarness().commit(async (tx) => {
      const running = ((await tx.doc(Tasks)).running ??= {});
      if (cid) running[String(id)] = String(cid);
      else delete running[String(id)];
    }, ctx);
  // A run cut off: it stops, marked so its follow-up knows.
  const interrupt = (c: Conversation) => Promise.all([c.abort(ctx).catch(() => {}), mark(c.id, { interrupted: true }).catch(() => {})]);
  // One model call through the gate, as task `id` (its model), with the request's messages.
  const ask = async (messages: unknown[]) => {
    const res = await api.call("POST", "/llm/chat/completions", JSON.stringify({ model: "task", messages }), { "content-type": "application/json" });
    return ((JSON.parse(res.text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "").trim();
  };

  // Each VM's pi-env daemon (the files and shell of its tasks' tools) and its browser, once something needs them.
  const vms = new Map<number, { connection: Connection; env: Promise<RemoteExecutionEnv>; browser?: Promise<McpClient> }>();
  function vm(id: number) {
    let found = vms.get(id);
    if (!found) {
      // A connection starts again on its next request once lost or closed: only while the task's run is under way, so
      // nothing left over from a run (a tool's cleanup) reaches for a VM the gate has put away.
      const connection = new Connection({
        command: async () => {
          if (!active.has(id)) throw new Error(`task #${id}'s run is over`);
          return daemon(id);
        },
        onLog: (text) => console.error(`pi-env #${id}: ${text.trim()}`),
      });
      const env = connection.info().then((info) => new RemoteExecutionEnv({ connection, id: `pi-env:biscotti-vm-${id}`, cwd: info.home }));
      found = { connection, env };
      env.catch(() => vms.delete(id));
      vms.set(id, found);
    }
    return found;
  }
  function browser(id: number) {
    const v = vm(id);
    v.browser ??= (async () => {
      const { home } = await v.connection.info();
      const client = new McpClient({ name: "biscotti", version: "1" });
      await client.connect(new PipeTransport({ open: ({ onStdout, onStderr }) => openProcess(v.connection, { cwd: home, argv: PLAYWRIGHT, env: DISPLAY, onStdout, onStderr }) }));
      return client;
    })();
    v.browser.catch(() => (v.browser = undefined));
    return v.browser;
  }
  // Done with VM `id` for now (its run ended): its browser and daemon stop, and start again if it's followed up.
  function release(id: number) {
    const v = vms.get(id);
    vms.delete(id);
    void v?.browser?.then((c) => c.close()).catch(() => {});
    v?.connection.close();
  }
  // A command in VM `id`: its output, and whether it succeeded.
  async function sh(id: number, command: string, timeout = 60) {
    const env = await vm(id).env;
    let out = "";
    const result = await env.exec(command, { env: DISPLAY, timeout, onOutput: (text) => (out += text) }, ctx);
    return { ok: result.ok && result.value.exitCode === 0, out: out.trim() };
  }
  async function file(id: number, path: string) {
    const read = await (await vm(id).env).readBinaryFile(path, ctx);
    return read.ok ? Buffer.from(read.value) : undefined;
  }
  async function screenshot(id: number) {
    return (await sh(id, "scrot -o /tmp/screen.png").catch(() => undefined))?.ok ? file(id, "/tmp/screen.png") : undefined;
  }

  // The task whose run a conversation is (only a run under way calls its tools), as a string for asTools.
  const taskId = (conversationId: ConversationId) => {
    const id = live.get(String(conversationId))?.id;
    return id === undefined ? undefined : String(id);
  };
  // The tasks with a run under way here: only they have their VM (the gate puts it away, or deletes it, once a run is
  // over, so nothing reaches for it after).
  const active = new Set<number>();

  // Each task's run under way in this process, by its conversation: whether its result was checked yet, and what the
  // requester has said since it started (the main agent's tell_task, which the gate passes on as it comes).
  const live = new Map<string, { id: number; conversation: Conversation; checked: boolean; asked: string; said: string[] }>();
  const mid = (message: string) => `[The requester, mid-task] ${message}`;
  const steer = (run: { conversation: Conversation; said: string[] }, message: string) => (run.said.push(message), run.conversation.submit({ type: "input", content: message, whenBusy: "steer" }, ctx));
  const goalNow = (run: { asked: string; said: string[] }) =>
    run.said.length ? `${run.asked}\n\nLater messages from the requester (the latest wins where they differ):\n${run.said.join("\n")}` : run.asked;

  // What the report or the screen still lacks for the goal, by a separate call with only the goal, the report and a
  // screenshot (none of the task's history); undefined when it's done.
  async function check(id: number, goal: string, report: string) {
    const png = await screenshot(id);
    if (!png) return undefined;
    const content = await ask([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `A task agent was given a goal and has reported. Check its work against the goal, using the screenshot of its final screen.

Goal: ${goal}

Report: ${report || "(none)"}

Done means: the report answers everything the goal asks, with the facts it needs (prices, times, confirmation numbers), and the screen backs it up (a confirmation shows, the values are right). Stopping before a payment, booking or message the goal didn't clearly ask for is done if the report says so, and so is a clear report that the site doesn't offer what was asked or blocked the agent. Answer with JSON only: {"done": true} or {"done": false, "missing": "what's missing or wrong, in a sentence"}.`,
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
        ],
      },
    ]);
    const verdict = JSON.parse(content.match(/\{[^{}]*"done"[^{}]*\}/)?.[0] ?? "{}") as { done?: boolean; missing?: string };
    return verdict.done === false && verdict.missing ? String(verdict.missing).slice(0, 500) : undefined;
  }

  // The gate's tools for tasks, the browser's and the VM's shell and files, for task conversations only. The gate's and
  // the browser's are listed from the first task's VM that has a browser (they're the same for every VM).
  const coding = createCodingTools();
  let extensions: Extension[] | undefined;
  async function install(id: number) {
    if (extensions) return extensions;
    const tools = await gate.tools(`task=${id}`, async (c) => (taskId(c) ? `task=${taskId(c)}` : undefined));
    const fromGate = defineExtension({
      name: "biscotti-task",
      tools,
      hooks: [
        hook(GenerationTask, {
          // All but the latest views of the page become a note (see LATEST).
          beforeRequest(request) {
            const views = request.messages.filter((m) => {
              const message = m as unknown as Message;
              return message.role === "toolResult" && (VIEW.test(message.toolName ?? "") || partsOf(message).some((p) => p.type === "image"));
            });
            const noted = new Set(views.slice(0, STEP * Math.floor(Math.max(0, views.length - LATEST) / STEP)));
            if (!noted.size) return undefined;
            return { messages: request.messages.map((m) => (noted.has(m) ? ({ ...m, content: [{ type: "text", text: NOTE }] } as typeof m) : m)) };
          },
          // A final answer: first what the requester said meanwhile; then, once, a fresh look at the final screen
          // against the goal, and if something's missing, the agent gets to fix it.
          async onYield(answer, api) {
            const run = live.get(String(api.conversationId));
            if (!run) return undefined;
            if (run.checked) return undefined;
            run.checked = true;
            const missing = await check(run.id, goalNow(run), textOf(answer as unknown as Message)).catch(() => undefined);
            if (!missing) return undefined;
            return { continue: `A check of the final screen against the goal found: ${missing}\nFix that if you can, or say why you can't, then end with your full report again, on the page that shows the result (e.g. the confirmation).` };
          },
        }),
      ],
    });
    const client = await browser(id).catch((err) => (console.error(`no browser in VM #${id}: ${(err as Error).message}`), undefined));
    const listed = client ? (await client.listTools()).filter((t) => BROWSER.has(t.name)) : [];
    const web = defineExtension({
      name: "biscotti-browser",
      tools: asTools(listed as McpTool[], async (c) => taskId(c), async (who, name, args) => (await browser(Number(who))).callTool(name, args)),
    });
    for (const extension of [coding, fromGate, web]) api.registry.install(extension);
    const selected = [coding, fromGate, web];
    if (listed.length) extensions = selected;
    return selected;
  }

  // Task `id`'s conversation (and its id alone, which reads less), once it has run.
  async function conversationId(id: number) {
    const known = (await getHarness().snapshot(Tasks, ctx))?.ids[String(id)];
    return known === undefined ? undefined : (Number(known) as unknown as ConversationId);
  }
  async function conversation(id: number) {
    const known = await conversationId(id);
    return known === undefined ? undefined : await getHarness().conversation(known, ctx);
  }
  // The conversation of task `id`: made for its first run, in its VM, with `instructions`.
  async function conversationOf(id: number, model: string, instructions: string): Promise<Conversation> {
    const harness = getHarness();
    const found = await conversation(id);
    if (found) return found;
    const selected = await install(id);
    const made = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "biscotti", modelId: model }, extensions: selected, instructions },
        init: async (tx, cid) => void Object.assign(await tx.doc(TaskDoc, cid), { id }),
      },
      ctx,
    );
    await harness.commit(async (tx) => void ((await tx.doc(Tasks)).ids[String(id)] = String(made.id)), ctx);
    board.started(id, made.id);
    return made;
  }

  // A plugin's own runner instead of the agent: its files run with node in the VM, the goal on stdin. Each line of its
  // stderr shows it isn't stuck; what it prints is the report.
  async function runOwn(task: TaskRun, alive: () => void) {
    const env = await vm(task.id).env;
    const dir = "/tmp/runner";
    await env.remove(dir, { recursive: true, force: true }, ctx);
    await env.createDir(dir, { recursive: true }, ctx);
    for (const [name, source] of Object.entries(task.runner!)) await env.writeFile(`${dir}/${name.replace(/[^\w.-]/g, "")}`, source, ctx);
    const { home } = await vm(task.id).connection.info();
    let out = "";
    const errors: string[] = [];
    const decoder = new TextDecoder();
    const child = await openProcess(vm(task.id).connection, {
      cwd: home,
      argv: ["node", `${dir}/main.ts`],
      env: DISPLAY,
      onStdout: (bytes) => void (out += decoder.decode(bytes, { stream: true })),
      onStderr: (bytes) => {
        alive();
        for (const text of Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean)) if (errors.push(text) > 20) errors.shift();
      },
    });
    child.write(task.goal);
    child.closeStdin();
    const code = await child.exited.catch(() => 1);
    const failed = code ? `The runner failed (exit ${code}):\n${errors.join("\n").slice(-3000)}` : "";
    return [failed, out.trim()].filter(Boolean).join("\n\n") || "The runner ended without a report.";
  }

  // One run of a task, until it's done, `stopped` (the gate gave up: stopped, or out of time) or quiet for `idleMs`
  // with no tool call under way: what was asked (or a follow-up) to the task's conversation, the requester's messages
  // passed on while it works; then its report, a screenshot of its final screen and what it collects.
  async function run(task: TaskRun & { idleMs: number }, stopped: AbortSignal) {
    const { id } = task;
    active.add(id);
    // The last sign of life, and the tool calls under way: a task in one (an install, a test run, the owner's yes) isn't
    // quiet, up to TOOL_QUIET_MAX_MS for any one call.
    let heard = Date.now();
    const open = new Map<string, number>();
    const quiet = new AbortController();
    const idle = setInterval(() => {
      if ([...open.values()].some((since) => Date.now() - since < TOOL_QUIET_MAX_MS)) heard = Date.now();
      else if (Date.now() - heard > task.idleMs) quiet.abort(new Error("the task went quiet"));
    }, Math.min(5_000, task.idleMs / 4));
    const ended = AbortSignal.any([stopped, quiet.signal]);
    try {
      const report = task.runner ? await runOwn(task, () => (heard = Date.now())) : await converse(task, ended, (entry) => {
        heard = Date.now();
        const m = entry.model?.[0];
        if (m?.role === "assistant") for (const p of partsOf(m)) if (p.type === "toolCall") open.set(p.id!, Date.now());
        if (m?.role === "toolResult" && m.toolCallId) open.delete(m.toolCallId);
      });
      ended.throwIfAborted();
      // Everything since the run's start, every time (a coding task's branch is pushed whole).
      let collected: string | undefined;
      if (task.collect) {
        const made = await sh(id, task.collect.command, 300);
        if (!made.ok) throw new Error(`collecting what it made: ${made.out.slice(-500)}`);
        if (made.out.split("\n").at(-1) !== "none") collected = (await file(id, task.collect.file))?.toString("base64");
      }
      const png = await screenshot(id);
      return { report, screenshot: png?.toString("base64"), collected };
    } catch (err) {
      if (ended.aborted) throw ended.reason;
      return { report: `The task couldn't run: ${(err as Error).message}` };
    } finally {
      clearInterval(idle);
      active.delete(id);
      release(id);
    }
  }

  // The task's conversation, through one run: each entry it commits to `heard`. Its report is what it said last.
  async function converse(task: TaskRun, ended: AbortSignal, heard: (entry: { model?: Message[] }) => void) {
    const { id } = task;
    const instructions = [PROMPT, ...(task.instructions ? [task.instructions] : [])].join("\n\n");
    const conversation = await conversationOf(id, task.model ?? "task", instructions);
    const harness = getHarness();
    const doc = (await harness.snapshot(TaskDoc, conversation.id, ctx)) ?? { id };
    const key = String(conversation.id);
    const state = { id, conversation, checked: task.check === false || Boolean(task.followup), asked: task.goal, said: [] as string[] };
    live.set(key, state);
    await underway(id, conversation.id);
    // Starting from its newest entry (the rest is the run before), keeping up to 200 new ones between looks.
    const watch = await conversation.watch(ctx, { min: 1, max: 200 });
    const seen = new Set(watch.value.entries.map((e) => String(e.id)));
    let report = "";
    watch.start(async (c) => {
      if (c.kind !== "value") return;
      for (const entry of c.value.entries as unknown as { id: unknown; model?: Message[] }[]) {
        if (seen.has(String(entry.id))) continue;
        seen.add(String(entry.id));
        heard(entry);
        const m = entry.model?.[0];
        const said = m?.role === "assistant" ? textOf(m) : "";
        if (said) report = said;
      }
    });
    // Cut off: it stops here too, marked so its follow-up knows.
    const cut = () => void interrupt(conversation);
    ended.addEventListener("abort", cut, { once: true });
    try {
      if (!task.followup) {
        const shape = SHAPES[task.display ?? ""];
        if (shape) await sh(id, `xrandr --fb ${shape} && wmctrl -r Chromium -b add,maximized_vert,maximized_horz`).catch(() => {});
      }
      const busy = (await harness.snapshot(LiveDoc, conversation.id, ctx))?.run !== undefined;
      if (busy && task.followup) await conversation.abort(ctx);
      const interrupted = busy || doc.interrupted;
      if (doc.interrupted) await mark(conversation.id, { interrupted: false });
      const content = task.followup
        ? `[The requester, following up${interrupted ? " on a run that was interrupted (it went quiet, ran out of time or was stopped; check what it got done)" : ""}] ${task.goal}`
        : task.goal;
      // The goal is the main agent's, a follow-up the owner's.
      const from = task.followup ? "user" : "agent";
      const submission = await conversation.submit({ type: "input", content, requestId: `task-${id}-${Date.now()}`, ...inputFrom(from) }, ctx);
      // What the requester said while it waited for a VM steers it from the start; later messages as they come.
      for (const message of task.told ?? []) await steer(state, mid(message)).catch(() => {});
      await submission.wait(ctx);
      // A message that came as the run ended starts it again.
      await conversation.waitForIdle(ctx);
      return report || "The task ended without a report.";
    } finally {
      ended.removeEventListener("abort", cut);
      watch.stop?.();
      live.delete(key);
      void underway(id).catch(() => {});
    }
  }

  // Its tasks and VMs as chats beside the session that started them.
  const board = chats(api, conversationId);
  link.handle("tasks/run", (task: TaskRun & { idleMs: number }, stopped: AbortSignal) => run(task, stopped));
  // The owner's message for task `id`'s run under way: it steers the run's next step.
  link.handle("tasks/steer", async ({ id, message }: { id: number; message: string }) => {
    const run = [...live.values()].find((r) => r.id === id);
    if (run) await steer(run, mid(message));
    return Boolean(run);
  });

  return {
    chats: board,
    // The environment of a task's run under way (its VM's), for the Harness; none for any other conversation. Asked at
    // every step of every conversation, so from memory.
    async env(conversationId: ConversationId): Promise<ExecutionEnv | undefined> {
      const run = live.get(String(conversationId));
      return run && active.has(run.id) ? vm(run.id).env : undefined;
    },
    // The gate restarted: its tools may have changed, so they're listed again for the next task.
    reload() {
      extensions = undefined;
    },
    // A run the agent was in the middle of when it stopped has no one waiting on it (the gate's request ended with
    // the link): it stops, marked as cut off for its follow-up, rather than carrying on in a VM that's gone.
    async settle() {
      const harness = getHarness();
      for (const [id, conversationId] of Object.entries((await harness.snapshot(Tasks, ctx))?.running ?? {})) {
        const cid = Number(conversationId) as unknown as ConversationId;
        const conversation = (await harness.snapshot(LiveDoc, cid, ctx))?.run !== undefined && (await harness.conversation(cid, ctx));
        if (conversation) await interrupt(conversation);
        await underway(Number(id)).catch(() => {});
      }
    },
  };
}
