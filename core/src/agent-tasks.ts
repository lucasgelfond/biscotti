import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import { inputFrom } from "pi-durable-ahp";
import {
  type Conversation,
  type ConversationId,
  type Extension,
  type Harness,
  type ToolExecutionResult,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, openProcess, RemoteExecutionEnv, type RemoteProcess } from "@earendil-works/pi-env";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// Tasks, run by the main agent: each a conversation of its own whose tools work in the task's VM, which the gate holds
// and sets up (tasks.ts). The shell and files are pi-env's daemon in the VM, reached through the gate (env-pipe.ts,
// vm-env.ts); the browser is Playwright's MCP server, run in the VM the same way; the gate's task tools (the vault,
// sharing a screenshot, lessons) are that VM's. The gate asks for a run on the agent's socket (POST /task) and reads
// what it does as lines: each tool call and message, then a screenshot of the final screen and a coding task's new
// commits. Its model calls go through the gate like the main agent's.

// The commands the task's VM runs as its user; a coding task's repo is checked out in ~/repo (by the gate's setup).
const REPO = "repo";
const DISPLAY = { DISPLAY: ":1" };
// How long one tool call may run without output before the gate may count the task as gone quiet.
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



// A task's instructions, and a coding task's besides.
const PROMPT = readFileSync(new URL("../TASK.md", import.meta.url), "utf8");
const CODING = readFileSync(new URL("../CODING.md", import.meta.url), "utf8");

// The desktop's shape for a task the owner watches from their phone: portrait and phone-sized, so sites lay out as
// they do on a phone. Chromium is maximized to fill it.
const SHAPES: Record<string, string> = { mobile: "432x936" };

// The commits since `base`, with anything left uncommitted committed first (in jj, the working copy's change,
// described if it isn't yet, and a new empty one on top, so git's HEAD has it), as a bundle at /tmp/out.bundle; prints
// "none" when there are none.
const COMMITS = (base: string) => `set -e
cd ~/${REPO}
if [ -d .jj ] && [ "$(jj log --no-graph -r @ -T empty)" = false ]; then
  [ -n "$(jj log --no-graph -r @ -T description)" ] || jj describe -m "Changes at the end of the task"
  jj new
fi
git add -A
[ -z "$(git status --porcelain)" ] || git commit -q -m "Uncommitted changes at the end of the task"
if [ "$(git rev-parse HEAD)" = "${base}" ]; then echo none; else git bundle create -q /tmp/out.bundle ${base}..HEAD; echo bundled; fi`;

// Which conversation each task is (by its number), its id as a string.
const Tasks = defineDoc<{ ids: Record<string, string> }>({ kind: "biscotti.tasks", version: 1, scope: "session", initial: () => ({ ids: {} }), checkpointWhen: () => true });
// A task's number (its VM's), for a coding task the commit its checkout started from, and whether its last run was cut
// off (the gate gave up on it: it went quiet, ran out of time or was stopped).
const TaskDoc = defineDoc<{ id: number; base?: string; interrupted?: boolean }>({
  kind: "biscotti.task",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: 0 }),
  checkpointWhen: () => false,
});

// What the gate asks for (tasks.ts): a task's first run, or a follow-up of one that already ran.
export interface TaskRun {
  id: number;
  // Its first run's goal, or the owner's message for a follow-up.
  goal: string;
  followup?: boolean;
  model?: string;
  coding?: boolean;
  display?: string;
  // A plugin's own runner instead of the agent: its files, run with node, the goal on stdin; what it prints is the report.
  runner?: Record<string, string>;
}

type Line = Record<string, unknown> & { type: string };
type Part = { type: string; text?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string };
type Message = { role: string; content: string | Part[]; toolName?: string; toolCallId?: string; isError?: boolean };
const partsOf = (m: Message): Part[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const textOf = (m: Message) => partsOf(m).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n").trim();
const said = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

// MCP over a program's stdin and stdout in the VM (pi-env's plain pipes), a line per message.
class RemoteStdio implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly #buffer = new ReadBuffer();
  #process?: RemoteProcess;
  readonly #open: (onStdout: (bytes: Uint8Array) => void) => Promise<RemoteProcess>;
  constructor(open: (onStdout: (bytes: Uint8Array) => void) => Promise<RemoteProcess>) {
    this.#open = open;
  }
  async start() {
    this.#process = await this.#open((bytes) => {
      this.#buffer.append(Buffer.from(bytes));
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.#buffer.readMessage();
        } catch (err) {
          this.onerror?.(err as Error);
          continue;
        }
        if (!message) break;
        this.onmessage?.(message);
      }
    });
    void this.#process.exited.catch(() => {}).finally(() => this.onclose?.());
  }
  async send(message: JSONRPCMessage) {
    this.#process?.write(serializeMessage(message));
  }
  async close() {
    this.#process?.close();
  }
}

// MCP results as pi-durable's: text and images.
const outputOf = (content: Part[]) =>
  content.flatMap((c): unknown[] => (c.type === "text" ? [{ type: "text", text: c.text ?? "" }] : c.type === "image" ? [{ type: "image", data: c.data, mimeType: c.mimeType }] : [])) as unknown as ToolExecutionResult["output"];

export function agentTasks(opts: {
  harness: () => Harness;
  ctx: Context;
  // The gate: a path's answer (its status and text), and one of its tools called as task `id`'s VM.
  call: (method: string, path: string, body?: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;
  // The command that starts pi-env's daemon in VM `id`, before its `serve` arguments (env-pipe.ts, through the gate).
  daemon: (id: number) => string[];
  // Task `id`'s conversation was just made, for its first run.
  onConversation?: (id: number, conversation: Conversation) => void;
}) {
  const { ctx, call } = opts;
  const gateMcp = async (id: number, method: string, params: object) => {
    const res = await call("POST", `/mcp?task=${id}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    if (res.status >= 300) throw new Error(`the gate: ${res.text}`);
    const reply = JSON.parse(res.text.match(/^data: (.*)$/m)?.[1] ?? res.text) as { result?: unknown; error?: { message: string } };
    if (reply.error) throw new Error(reply.error.message);
    return reply.result as { tools?: { name: string; description?: string; inputSchema: object }[]; content?: Part[]; isError?: boolean };
  };
  const gateTool = async (id: number, name: string, args: object) => {
    const result = await gateMcp(id, "tools/call", { name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${(result.content ?? []).map((c) => c.text ?? "").join("\n")}`);
    return (result.content ?? []).map((c) => c.text ?? "").join("\n");
  };
  // One model call through the gate, as task `id` (its model), with the request's messages.
  const ask = async (messages: unknown[]) => {
    const res = await call("POST", "/llm/chat/completions", JSON.stringify({ model: "task", messages }), { "content-type": "application/json" });
    return ((JSON.parse(res.text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "").trim();
  };

  // Each VM's pi-env daemon (the files and shell of its tasks' tools) and its browser, once something needs them.
  const vms = new Map<number, { connection: Connection; env: Promise<RemoteExecutionEnv>; browser?: Promise<Client> }>();
  function vm(id: number) {
    let found = vms.get(id);
    if (!found) {
      // A connection starts again on its next request once lost or closed: only while the task's run is under way, so
      // nothing left over from a run (a tool's cleanup) reaches for a VM the gate has put away.
      const connection = new Connection({
        command: async () => {
          if (!active.has(id)) throw new Error(`task #${id}'s run is over`);
          return opts.daemon(id);
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
      const client = new Client({ name: "biscotti", version: "1" });
      await client.connect(new RemoteStdio((onStdout) => openProcess(v.connection, { cwd: home, argv: PLAYWRIGHT, env: DISPLAY, onStdout, onStderr: () => {} })));
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

  const taskOf = async (conversationId: ConversationId, c: Context) => (await opts.harness().snapshot(TaskDoc, conversationId, c))?.id;
  // The tasks with a run under way here: only they have their VM (the gate puts it away, or deletes it, once a run is
  // over, so nothing reaches for it after).
  const active = new Set<number>();

  // What each task's run is doing now, in this process: where its lines go, whether its result was checked yet, and
  // what the requester has said since it started.
  const live = new Map<string, { id: number; send: (line: Line) => void; checked: boolean; asked: string; said: string[] }>();
  // What the requester said since the task started (the main agent's tell_task, which the gate holds for its VM).
  const told = async (id: number) => {
    const res = await call("GET", `/messages?task=${id}`).catch(() => undefined);
    const got = res && res.status < 300 ? (JSON.parse(res.text) as unknown) : [];
    return Array.isArray(got) ? got.map((m) => `[The requester, mid-task] ${String(m)}`) : [];
  };
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
  async function install(id: number, registry: { install(e: Extension): void }) {
    if (extensions) return extensions;
    const fromGate = (await gateMcp(id, "tools/list", {})).tools ?? [];
    const gate = defineExtension({
      name: "biscotti-task",
      tools: fromGate.map((t) =>
        defineTool({
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema,
          execute: async (args, api): Promise<ToolExecutionResult> => {
            const task = await taskOf(api.conversationId, ctx);
            if (!task) return { output: [{ type: "text", text: "not a task" }] as never, isError: true };
            const result = await gateMcp(task, "tools/call", { name: t.name, arguments: args });
            return { output: outputOf(result.content ?? []), isError: result.isError };
          },
        }),
      ),
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
            const late = await told(run.id);
            if (late.length) return (run.said.push(...late), { continue: late.join("\n") });
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
    const listed = client ? (await client.listTools()).tools.filter((t) => BROWSER.has(t.name)) : [];
    const web = defineExtension({
      name: "biscotti-browser",
      tools: listed.map((t) =>
        defineTool({
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema as object,
          execute: async (args, api): Promise<ToolExecutionResult> => {
            const task = await taskOf(api.conversationId, ctx);
            if (!task) return { output: [{ type: "text", text: "not a task" }] as never, isError: true };
            const result = await (await browser(task)).callTool({ name: t.name, arguments: args as Record<string, unknown> });
            return { output: outputOf(result.content as Part[]), isError: Boolean(result.isError) };
          },
        }),
      ),
    });
    registry.install(coding);
    registry.install(gate);
    registry.install(web);
    const selected = [coding, gate, web];
    if (listed.length) extensions = selected;
    return selected;
  }

  // The conversation of task `id`: made for its first run, in its VM, with `instructions`.
  async function conversationOf(id: number, model: string, instructions: string, registry: { install(e: Extension): void }): Promise<Conversation> {
    const harness = opts.harness();
    const known = (await harness.snapshot(Tasks, ctx))?.ids[String(id)];
    const found = known && (await harness.conversation(Number(known) as unknown as ConversationId, ctx));
    if (found) return found;
    const selected = await install(id, registry);
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "biscotti", modelId: model }, extensions: selected, instructions },
        init: async (tx, cid) => void Object.assign(await tx.doc(TaskDoc, cid), { id }),
      },
      ctx,
    );
    await harness.commit(async (tx) => void ((await tx.doc(Tasks)).ids[String(id)] = String(conversation.id)), ctx);
    opts.onConversation?.(id, conversation);
    return conversation;
  }

  // A plugin's own runner instead of the agent: its files run with node in the VM, the goal on stdin. Its stderr goes
  // back line by line as progress, which also tells the gate it isn't stuck; what it prints is the report.
  async function runOwn(task: TaskRun, send: (line: Line) => void) {
    const env = await vm(task.id).env;
    const dir = "/tmp/runner";
    await env.remove(dir, { recursive: true, force: true }, ctx);
    await env.createDir(dir, { recursive: true }, ctx);
    for (const [name, source] of Object.entries(task.runner!)) await env.writeFile(`${dir}/${name.replace(/[^\w.-]/g, "")}`, source, ctx);
    const { home } = await vm(task.id).connection.info();
    let out = "";
    const errors: string[] = [];
    let partial = "";
    const decoder = new TextDecoder();
    const child = await openProcess(vm(task.id).connection, {
      cwd: home,
      argv: ["node", `${dir}/main.ts`],
      env: DISPLAY,
      onStdout: (bytes) => void (out += decoder.decode(bytes, { stream: true })),
      onStderr: (bytes) => {
        partial += Buffer.from(bytes).toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const text of lines) {
          if (errors.push(text) > 20) errors.shift();
          send({ type: "progress", text: text.slice(0, 500) });
        }
      },
    });
    child.write(task.goal);
    child.closeStdin();
    const code = await child.exited.catch(() => 1);
    const failed = code ? `The runner failed (exit ${code}):\n${errors.join("\n").slice(-3000)}` : "";
    return [failed, out.trim()].filter(Boolean).join("\n\n") || "The runner ended without a report.";
  }

  // One run of a task, its lines to `res` as it goes: what was asked (or a follow-up) to the task's conversation, the
  // requester's messages passed on while it works, then what the gate gets back at the end.
  async function run(task: TaskRun, res: ServerResponse, registry: { install(e: Extension): void }) {
    const send = (line: Line) => void (!res.destroyed && res.write(`${JSON.stringify(line)}\n`));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const { id } = task;
    active.add(id);
    try {
      if (task.runner) {
        send(said(await runOwn(task, send)));
        const png = await screenshot(id);
        if (png) send({ type: "screenshot", png: png.toString("base64") });
        return;
      }
      const harness = opts.harness();
      // Lessons from earlier tasks on the goal's sites (the lessons plugin's).
      const lessons = task.followup || task.coding ? undefined : await gateTool(id, "lessons_for", { goal: task.goal }).catch(() => undefined);
      const instructions = [PROMPT, ...(task.coding ? [CODING] : []), ...(lessons ? [lessons] : [])].join("\n\n");
      const conversation = await conversationOf(id, task.model ?? "task", instructions, registry);
      const key = String(conversation.id);
      let doc = (await harness.snapshot(TaskDoc, conversation.id, ctx)) ?? { id };
      if (task.coding && !doc.base) {
        const base = (await sh(id, `git -C ~/${REPO} rev-parse HEAD`)).out;
        await harness.commit(async (tx) => void ((await tx.doc(TaskDoc, conversation.id)).base = base), ctx);
        doc = { ...doc, base };
      }
      const state = { id, send, checked: Boolean(task.coding || task.followup), asked: task.goal, said: [] as string[] };
      live.set(key, state);

      // Its entries as lines, as they're committed; a heartbeat while a tool call runs (an install, a test run), up
      // to TOOL_QUIET_MAX_MS for any one call, after which the gate's idle limit applies.
      const watch = await conversation.watch(ctx);
      const seen = new Set(watch.value.entries.map((e) => String(e.id)));
      const open = new Map<string, { name: string; since: number }>();
      watch.start(async (c) => {
        if (c.kind !== "value") return;
        for (const entry of c.value.entries as unknown as { id: unknown; model?: Message[] }[]) {
          if (seen.has(String(entry.id))) continue;
          seen.add(String(entry.id));
          const m = entry.model?.[0];
          if (m?.role === "assistant") {
            for (const p of partsOf(m)) {
              if (p.type !== "toolCall") continue;
              open.set(p.id!, { name: p.name!, since: Date.now() });
              send({ type: "tool_execution_start", toolCallId: p.id, toolName: p.name, args: p.arguments });
            }
            const text = textOf(m);
            if (text) send(said(text));
          }
          if (m?.role === "toolResult" && m.toolCallId) {
            open.delete(m.toolCallId);
            send({ type: "tool_execution_end", toolCallId: m.toolCallId, isError: Boolean(m.isError) });
          }
        }
      });
      const heartbeat = setInterval(() => {
        const tools = [...open.values()].filter((t) => Date.now() - t.since < TOOL_QUIET_MAX_MS);
        if (tools.length) send({ type: "heartbeat", tools: tools.map((t) => t.name) });
      }, 30_000);
      // The requester's messages reach it as they come: while it works they steer its next step.
      const poll = setInterval(async () => {
        const messages = await told(id);
        if (!messages.length) return;
        state.said.push(...messages);
        for (const message of messages) await conversation.submit({ type: "input", content: message, whenBusy: "steer" }, ctx).catch(() => {});
      }, 3000);
      // The gate gave up on this run (it went quiet, ran out of time or was stopped): it stops here too.
      let ended = false;
      res.on("close", () => {
        if (ended) return;
        void conversation.abort(ctx).catch(() => {});
        void harness.commit(async (tx) => void ((await tx.doc(TaskDoc, conversation.id)).interrupted = true), ctx).catch(() => {});
      });
      try {
        if (!task.followup) {
          const shape = SHAPES[task.display ?? ""];
          if (shape) await sh(id, `xrandr --fb ${shape} && wmctrl -r Chromium -b add,maximized_vert,maximized_horz`).catch(() => {});
        }
        const busy = (await harness.snapshot(LiveDoc, conversation.id, ctx))?.run !== undefined;
        if (busy && task.followup) await conversation.abort(ctx);
        const interrupted = busy || doc.interrupted;
        if (doc.interrupted) await harness.commit(async (tx) => void ((await tx.doc(TaskDoc, conversation.id)).interrupted = false), ctx);
        const content = task.followup
          ? `[The requester, following up${interrupted ? " on a run that was interrupted (it went quiet, ran out of time or was stopped; check what it got done)" : ""}] ${task.goal}`
          : task.goal;
        // The goal is the main agent's, a follow-up the owner's.
        const from = task.followup ? "user" : "agent";
        const submission = await conversation.submit({ type: "input", content, requestId: `task-${id}-${Date.now()}`, ...inputFrom(from) }, ctx);
        await submission.wait(ctx);
        // A message that came as the run ended starts it again.
        await conversation.waitForIdle(ctx);
      } finally {
        ended = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        watch.stop?.();
        live.delete(key);
      }
      if (doc.base) {
        // Everything since the base, every time: the gate pushes the whole branch.
        const bundled = await sh(id, COMMITS(doc.base), 300);
        const data = bundled.ok && bundled.out.endsWith("bundled") ? await file(id, "/tmp/out.bundle") : undefined;
        if (data) send({ type: "bundle", data: data.toString("base64") });
        else if (!bundled.ok) send(said(`Couldn't bundle the commits: ${bundled.out.slice(-500)}`));
      }
      const png = await screenshot(id);
      if (png) send({ type: "screenshot", png: png.toString("base64") });
    } catch (err) {
      send(said(`The task couldn't run: ${(err as Error).message}`));
    } finally {
      active.delete(id);
      release(id);
      res.end();
    }
  }

  return {
    run,
    // Task `id`'s conversation, once it has run.
    async conversation(id: number) {
      const harness = opts.harness();
      const known = (await harness.snapshot(Tasks, ctx))?.ids[String(id)];
      return known ? await harness.conversation(Number(known) as unknown as ConversationId, ctx) : undefined;
    },
    // The environment of a task's conversation (its VM's), for the Harness; none for any other.
    async env(conversationId: ConversationId, read: { snapshot: Harness["snapshot"] }, c: Context): Promise<ExecutionEnv | undefined> {
      const task = await (read.snapshot as (doc: typeof TaskDoc, id: ConversationId, c: Context) => Promise<{ id: number } | undefined>)(TaskDoc, conversationId, c);
      return task?.id && active.has(task.id) ? vm(task.id).env : undefined;
    },
    // The gate restarted: its tools may have changed, so they're listed again for the next task.
    reload() {
      extensions = undefined;
    },
    // A run the agent was in the middle of when it stopped has no one waiting on it (the gate gave up when its
    // stream ended): it stops, marked as cut off for its follow-up, rather than carrying on in a VM that's gone.
    async settle() {
      const harness = opts.harness();
      for (const conversationId of Object.values((await harness.snapshot(Tasks, ctx))?.ids ?? {})) {
        const cid = Number(conversationId) as unknown as ConversationId;
        if ((await harness.snapshot(LiveDoc, cid, ctx))?.run === undefined) continue;
        await (await harness.conversation(cid, ctx))?.abort(ctx).catch(() => {});
        await harness.commit(async (tx) => void ((await tx.doc(TaskDoc, cid)).interrupted = true), ctx).catch(() => {});
      }
    },
  };
}
