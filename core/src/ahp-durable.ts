import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { StateAction, URI } from "@microsoft/agent-host-protocol";
import type { AhpHost } from "./ahp.ts";

// A pi-durable conversation as an AHP chat: what it has said becomes the chat's turns, then each commit becomes the
// chat's actions (a turn started, its text, its tool calls and their results, its usage, how it ended). Clients' actions
// on the chat go back to the conversation: a turn started is an input, a turn cancelled stops the run. Nothing here is
// biscotti's, so it can stand on its own as an AHP host for pi-durable.

type Part = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role: string; content: string | Part[]; model?: string; usage?: { input: number; output: number; cacheRead?: number }; toolCallId?: string; toolName?: string; isError?: boolean };
type Entry = { id: unknown; kind: string; model?: readonly Message[] };

const act = (action: object) => action as StateAction;
const parts = (m: Message): Part[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const textOf = (m: Message) => parts(m).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n");
// Inputs carry the time they were sent as a prefix, for the model; the chat shows what was said.
const said = (text: string) => text.replace(/^\[[^\]]*\] /, "");
const now = () => new Date().toISOString();
// A message's usage, as AHP has it: input without what came from the cache, which is counted on its own; and the model
// by the name `named` gives it.
const usageOf = (m: Message, named: (id: string) => string) =>
  m.usage && { inputTokens: m.usage.input, outputTokens: m.usage.output, cacheReadTokens: m.usage.cacheRead, ...(m.model && { model: named(m.model) }) };

export function chatState(uri: URI, title: string, meta?: Record<string, unknown>) {
  return { resource: uri, title, status: 1, modifiedAt: now(), origin: { kind: "user" }, turns: [] as unknown[], ...(meta && { _meta: meta }) };
}

// The turns a conversation's entries make, for a chat's first state: each input starts one, and everything after it
// up to the next is its answer.
function turnsOf(entries: readonly Entry[], named: (id: string) => string) {
  const turns: { id: string; message: object; responseParts: object[]; usage: object | undefined; state: string }[] = [];
  const calls = new Map<string, { toolCall: Record<string, unknown> }>();
  for (const entry of entries) {
    const m = entry.model?.[0];
    if (!m) continue;
    if (m.role === "user") turns.push({ id: String(entry.id), message: { text: said(textOf(m)), origin: { kind: "user" } }, responseParts: [], usage: undefined, state: "complete" });
    const turn = turns.at(-1);
    if (!turn) continue;
    if (m.role === "assistant") {
      parts(m).forEach((p, i) => {
        if (p.type === "text" && p.text) turn.responseParts.push({ kind: "markdown", id: `${String(entry.id)}:${i}`, content: p.text });
        if (p.type === "toolCall") {
          const part = { kind: "toolCall", toolCall: { status: "completed", toolCallId: p.id, toolName: p.name, displayName: p.name, invocationMessage: p.name, toolInput: JSON.stringify(p.arguments ?? {}), confirmed: "not-needed", success: true, pastTenseMessage: p.name } };
          calls.set(p.id!, part);
          turn.responseParts.push(part);
        }
      });
      if (m.usage) turn.usage = usageOf(m, named);
    }
    if (m.role === "toolResult" && m.toolCallId) {
      const call = calls.get(m.toolCallId);
      if (call) Object.assign(call.toolCall, { success: !m.isError, content: [{ type: "text", text: textOf(m) }] });
    }
  }
  return turns;
}

export class DurableChat {
  // The turn under way: its id (a client's, or the input entry's), when it started, and whether its input is in yet.
  #turn?: { id: string; started: number; placed: boolean };
  #running = false;
  readonly #seen = new Set<string>();

  readonly host: AhpHost;
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly uri: URI;
  readonly ctx: Context;
  // When the chat's status changes (idle, working), for the session's catalogue.
  readonly onStatus?: (status: number) => void;
  // A model's name for the apps (the conversation knows it by the provider's id for it).
  readonly named: (id: string) => string;
  // How a client's message reaches the conversation (as its input, unless the conversation is someone else's to
  // feed, like a task's); its turn starts when the conversation takes it in.
  readonly send?: (text: string, turnId: string) => Promise<void>;
  constructor(opts: {
    host: AhpHost;
    harness: Harness;
    conversation: Conversation;
    uri: URI;
    ctx: Context;
    onStatus?: (status: number) => void;
    named?: (id: string) => string;
    send?: (text: string, turnId: string) => Promise<void>;
  }) {
    this.host = opts.host;
    this.harness = opts.harness;
    this.conversation = opts.conversation;
    this.uri = opts.uri;
    this.ctx = opts.ctx;
    this.onStatus = opts.onStatus;
    this.named = opts.named ?? ((id) => id);
    this.send = opts.send;
  }

  get running() {
    return this.#running || (this.#turn !== undefined && !this.#turn.placed);
  }

  // The chat's channel, with the turns so far, then its actions as the conversation commits. A channel already open
  // (one made before the conversation, for a task waiting for its VM) carries on with them.
  async open(title: string, meta?: Record<string, unknown>) {
    const watch = await this.conversation.watch(this.ctx, { min: 200, max: 400 });
    const entries = watch.value.entries as unknown as Entry[];
    if (this.host.has(this.uri)) for (const e of entries) this.#entry(e);
    for (const e of entries) this.#seen.add(String(e.id));
    if (!this.host.has(this.uri)) this.host.create(this.uri, { ...chatState(this.uri, title, meta), turns: turnsOf(entries, this.named) });
    this.#running = (watch.value.docs as Record<string, { run?: unknown } | undefined>)["pi.live"]?.run !== undefined;
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      const value = call.value as unknown as { entries: Entry[]; docs: Record<string, { run?: unknown; runFailure?: { reason: string; detail?: string } } | undefined> };
      for (const e of value.entries) if (!this.#seen.has(String(e.id))) (this.#seen.add(String(e.id)), this.#entry(e));
      const live = value.docs["pi.live"];
      const running = live?.run !== undefined;
      if (this.#running && !running) this.#end(live?.runFailure);
      this.#running = running;
    });
  }

  #dispatch(action: object) {
    this.host.dispatch(this.uri, act(action));
  }

  #entry(e: Entry) {
    const m = e.model?.[0];
    if (!m) return;
    if (m.role === "user") {
      // A client's turn is already started; anything else (a text, a wake) starts its own.
      if (this.#turn && !this.#turn.placed) return void (this.#turn.placed = true);
      this.#turn = { id: String(e.id), started: Date.now(), placed: true };
      this.#dispatch({ type: "chat/turnStarted", turnId: this.#turn.id, startedAt: now(), message: { text: said(textOf(m)), origin: { kind: "user" } } });
      this.onStatus?.(8);
      return;
    }
    const turnId = this.#turn?.id;
    if (!turnId) return;
    if (m.role === "assistant") {
      parts(m).forEach((p, i) => {
        if (p.type === "text" && p.text) this.#dispatch({ type: "chat/responsePart", turnId, part: { kind: "markdown", id: `${String(e.id)}:${i}`, content: p.text } });
        if (p.type === "toolCall") {
          this.#dispatch({ type: "chat/toolCallStart", turnId, toolCallId: p.id, toolName: p.name, displayName: p.name });
          this.#dispatch({ type: "chat/toolCallReady", turnId, toolCallId: p.id, invocationMessage: p.name, toolInput: JSON.stringify(p.arguments ?? {}), confirmed: "not-needed" });
        }
      });
      if (m.usage) this.#dispatch({ type: "chat/usage", turnId, usage: usageOf(m, this.named) });
    }
    if (m.role === "toolResult" && m.toolCallId)
      this.#dispatch({ type: "chat/toolCallComplete", turnId, toolCallId: m.toolCallId, result: { success: !m.isError, pastTenseMessage: m.toolName ?? "", content: [{ type: "text", text: textOf(m) }] } });
  }

  #end(failure?: { reason: string; detail?: string }) {
    const turn = this.#turn;
    this.#turn = undefined;
    this.onStatus?.(1);
    if (!turn) return;
    const duration = Date.now() - turn.started;
    if (!failure) return this.#dispatch({ type: "chat/turnComplete", turnId: turn.id, duration });
    if (failure.reason === "aborted") return this.#dispatch({ type: "chat/turnCancelled", turnId: turn.id, duration });
    this.#dispatch({ type: "chat/error", turnId: turn.id, duration, part: { kind: "error", error: { errorType: failure.reason, message: failure.detail ?? failure.reason } } });
  }

  // A client started a turn (its action is committed already): its message is the conversation's input.
  async started(turnId: string, text: string) {
    this.#turn = { id: turnId, started: Date.now(), placed: false };
    this.onStatus?.(8);
    if (this.send) return this.send(text, turnId);
    await this.conversation.submit({ type: "input", content: `[${new Date().toString()}] ${text}`, requestId: turnId }, this.ctx);
  }

  // A client's turn that never reached the conversation (it was refused), ended with why.
  refused(turnId: string, why: string) {
    if (this.#turn?.id === turnId) this.#turn = undefined;
    this.onStatus?.(1);
    this.#dispatch({ type: "chat/error", turnId, duration: 0, part: { kind: "error", error: { errorType: "refused", message: why } } });
  }

  async cancel() {
    await this.conversation.abort(this.ctx);
  }

  busy() {
    return this.harness.snapshot(LiveDoc, this.conversation.id, this.ctx).then((live) => live?.run !== undefined);
  }
}
