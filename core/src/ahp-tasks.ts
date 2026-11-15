import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { StateAction, URI } from "@microsoft/agent-host-protocol";
import type { AhpHost } from "./ahp.ts";
import { chatState, DurableChat } from "./ahp-durable.ts";
import type { Row } from "./board.ts";

// The board's sandboxes (tasks) and VMs as chats of the session that started them (a VM's, and a task's from the
// owner's texts, in "main"): ahp-chat:/<session>/<number>. Each chat's state, and its entry in its session's
// _meta.biscotti.chats (so a list shows them without subscribing to each), is its row as the apps read it (RECORD,
// below). A sandbox's turns are its task's own conversation; what a client says in one goes to the task through the
// gate (it's told it while running, or a kept one is resumed with it), and cancelling a turn stops the task.

const CHAT = "ahp-chat:/";
const SESSION = "ahp-session:/";
// AHP's chat statuses: idle, and working.
const IDLE = 1;
const WORKING = 8;

// What the apps read of a row.
const record = (row: Row) => ({
  kind: row.kind,
  status: row.status,
  title: row.goal.split("\n")[0].slice(0, 200),
  ...(row.report && { report: row.report }),
  ...(row.repo && { repo: row.repo }),
  ...(row.where && { where: row.where }),
  ...(row.slot !== undefined && { slot: row.slot }),
  ...(row.ssh && { ssh: row.ssh }),
  ...(row.hostKey && { hostKey: row.hostKey }),
  ...(row.site && { site: row.site }),
  ...(row.preview && { preview: row.preview }),
  updated: row.updated,
});
const isChat = (row: Row) => row.kind === "sandbox" || row.kind === "vm";
const sessionOfRow = (row: Row) => (row.kind === "sandbox" && row.parent ? row.parent : "main");
const statusOf = (row: Row) => (row.status === "running" || row.status === "queued" || row.status === "moving" ? WORKING : IDLE);

export function taskChats(opts: {
  host: AhpHost;
  harness: () => Harness;
  ctx: Context;
  // The gate's methods for the apps (x-biscotti/<name>, appMethod), and its board as it changes.
  method: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  follow: (path: string, onLine: (line: Record<string, unknown>) => void) => void;
  // Task `id`'s conversation, once it has run.
  conversation: (id: number) => Promise<Conversation | undefined>;
  named: (id: string) => string;
  // A session's _meta changed (its chats): for its state and the catalogue.
  changed: (session: string) => void;
}) {
  const { host } = opts;
  const rows = new Map<number, Row>();
  const chats = new Map<URI, DurableChat>();
  const uriOf = (row: Row): URI => `${CHAT}${sessionOfRow(row)}/${row.id}`;
  const idOf = (uri: string) => {
    const m = uri.match(/^ahp-chat:\/([^/]+)\/(\d+)$/);
    return m ? Number(m[2]) : undefined;
  };
  const summary = (row: Row) => ({ resource: uriOf(row), title: record(row).title, status: statusOf(row), modifiedAt: new Date(row.updated).toISOString(), origin: { kind: "user" }, _meta: { biscotti: record(row) } });

  // A sandbox chat backed by its task's conversation (once it has one), else a chat with only its row.
  async function open(row: Row, conversation?: Conversation) {
    const uri = uriOf(row);
    if (chats.has(uri)) return;
    const meta = { biscotti: record(row) };
    conversation ??= row.kind === "sandbox" ? await opts.conversation(row.id) : undefined;
    if (!conversation) {
      if (!host.has(uri)) host.create(uri, { ...chatState(uri, record(row).title, meta), status: statusOf(row) });
      return;
    }
    const chat = new DurableChat({
      host,
      harness: opts.harness(),
      conversation,
      uri,
      ctx: opts.ctx,
      named: opts.named,
      send: async (text, turnId) => {
        const { told } = (await opts.method("tell", { id: row.id, message: text })) as { told: string };
        if (told === "none") chat.refused(turnId, `#${row.id} isn't running or kept any more: start a new task for this`);
      },
    });
    chats.set(uri, chat);
    await chat.open(record(row).title, meta);
  }

  // Each change of a row: its chat in its session (added, updated or removed) and the session's chats.
  opts.follow("/board", (line) => {
    const row = line as unknown as Row;
    const before = rows.get(row.id);
    if (row.kind === "gone") {
      rows.delete(row.id);
      if (!before || !isChat(before)) return;
      const uri = uriOf(before);
      const session = `${SESSION}${sessionOfRow(before)}`;
      chats.delete(uri);
      host.delete(uri);
      if (host.has(session)) host.dispatch(session, { type: "session/chatRemoved", chat: uri } as unknown as StateAction);
      return opts.changed(sessionOfRow(before));
    }
    rows.set(row.id, row);
    if (!isChat(row)) return;
    const session = `${SESSION}${sessionOfRow(row)}`;
    if (host.has(session)) {
      const { resource, origin, ...changes } = summary(row);
      host.dispatch(
        session,
        (before ? { type: "session/chatUpdated", chat: resource, changes } : { type: "session/chatAdded", summary: summary(row) }) as unknown as StateAction,
      );
    }
    opts.changed(sessionOfRow(row));
  });

  return {
    // A session's sandboxes and VMs, for its _meta.biscotti.chats.
    of(session: string) {
      return Object.fromEntries([...rows.values()].filter((r) => isChat(r) && sessionOfRow(r) === session).map((r) => [uriOf(r), record(r)]));
    },
    // A session's chats, as it opens.
    summaries(session: string) {
      return [...rows.values()].filter((r) => isChat(r) && sessionOfRow(r) === session).map(summary);
    },
    owns: (uri: string) => idOf(uri) !== undefined,
    // A chat a client asked for: true once it's there.
    async hydrate(uri: string) {
      const id = idOf(uri);
      const row = id === undefined ? undefined : rows.get(id);
      if (!row || !isChat(row) || uriOf(row) !== uri) return false;
      await open(row);
      return host.has(uri);
    },
    // A task's conversation was just made: its chat, if a client has it open already, follows it from here.
    async started(id: number, conversation: Conversation) {
      const row = rows.get(id);
      if (row && host.has(uriOf(row)) && !chats.has(uriOf(row))) await open(row, conversation);
    },
    validate(channel: URI, action: StateAction) {
      const row = rows.get(idOf(channel) ?? 0);
      if ((action.type as string) === "chat/turnStarted" && row?.kind === "vm") return "this is a VM to ssh into; it takes no messages";
      return undefined;
    },
    acted(channel: URI, action: StateAction) {
      const id = idOf(channel)!;
      const a = action as unknown as { type: string; turnId: string; message?: { text: string } };
      if (a.type === "chat/turnStarted") {
        const chat = chats.get(channel);
        if (chat) return void chat.started(a.turnId, a.message?.text ?? "").catch((err) => chat.refused(a.turnId, (err as Error).message));
        // A sandbox with no conversation here yet (from before tasks ran in the agent): told through the gate.
        void opts.method("tell", { id, message: a.message?.text ?? "" }).catch(() => {});
      }
      if (a.type === "chat/turnCancelled") void opts.method("stop", { id }).catch(() => {});
    },
    // Deleted for good: its VM (a VM's, through its plugin), and its row.
    async dispose(uri: URI) {
      const id = idOf(uri)!;
      const row = rows.get(id);
      if (row?.kind === "vm") await opts.method("vms.close", { sessionId: String(id), discard: true });
      await opts.method("remove", { id });
    },
    // The apps' methods (x-biscotti/<name>), passed to the gate; a VM's come back with its chat.
    methods: {
      "x-biscotti/watch": async (p: Record<string, unknown>) => opts.method("watch", { id: idOf(String(p.channel)) }),
      "x-biscotti/github": async (p: Record<string, unknown>) => {
        const { status, body } = (await opts.method("github", { path: p.path })) as { status: number; body: unknown };
        return { status, body: JSON.stringify(body) };
      },
      "x-biscotti/devices.register": async (p: Record<string, unknown>) => opts.method("devices.register", p),
      "x-biscotti/vms.open": async (p: Record<string, unknown>) => {
        const vm = (await opts.method("vms.open", { key: p.key, repo: p.repo, where: p.where })) as { id: number };
        return { ...vm, channel: `${CHAT}main/${vm.id}` };
      },
      "x-biscotti/vms.reopen": async (p: Record<string, unknown>) => opts.method("vms.reopen", { sessionId: String(p.id ?? idOf(String(p.channel))), key: p.key }),
      "x-biscotti/vms.close": async (p: Record<string, unknown>) => opts.method("vms.close", { sessionId: String(p.id ?? idOf(String(p.channel))), discard: Boolean(p.discard) }),
    } as Record<string, (params: Record<string, unknown>) => Promise<unknown>>,
  };
}
