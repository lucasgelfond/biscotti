import type { ConversationId } from "@earendil-works/pi-durable";
import type { Chat } from "pi-durable-acp-ahp";
import type { Row } from "./board.ts";

// The board's tasks (sandboxes) and VMs as chats beside the session that started them (pi-durable-acp-ahp's `chats`): a
// task's in its parent session, a VM's in "main", each keyed by its number. A chat's _meta.biscotti, and its session's
// _meta.biscotti.chats (so a list shows them without subscribing to each), is its row as the apps read it. A task's turns
// are its own conversation's; what a client says in one goes to the task through the gate (told while it runs, or a
// kept one resumed), stopping a turn stops the task, deleting it deletes its VM.

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
const sessionOf = (row: Row) => (row.kind === "sandbox" && row.parent ? row.parent : "main");

export function sandboxes(opts: {
  // The gate's methods for the apps (appMethod), and its board as it changes.
  method: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  follow: (path: string, onLine: (line: Record<string, unknown>) => void) => void;
  // Task `id`'s conversation, once it has run.
  conversation: (id: number) => Promise<ConversationId | undefined>;
  // A session's chats changed.
  changed: (session: string) => void;
}) {
  const rows = new Map<number, Row>();
  const conversations = new Map<number, ConversationId>();
  const rowOf = (key: string) => rows.get(Number(key));

  opts.follow("/board", (line) => {
    const row = line as unknown as Row;
    const before = rows.get(row.id);
    if (row.kind === "gone") {
      rows.delete(row.id);
      if (before && isChat(before)) opts.changed(sessionOf(before));
      return;
    }
    rows.set(row.id, row);
    if (!isChat(row)) return;
    if (row.kind === "sandbox" && !conversations.has(row.id))
      void opts.conversation(row.id).then((id) => id !== undefined && (conversations.set(row.id, id), opts.changed(sessionOf(row))), () => {});
    opts.changed(sessionOf(row));
  });

  const of = (session: string) => [...rows.values()].filter((r) => isChat(r) && sessionOf(r) === session);
  return {
    chats: (session: string): Chat[] =>
      of(session).map((row) => ({
        key: String(row.id),
        title: record(row).title,
        working: row.status === "running" || row.status === "queued",
        modifiedAt: new Date(row.updated).toISOString(),
        ...(conversations.has(row.id) && { conversation: conversations.get(row.id) }),
        _meta: { biscotti: record(row) },
      })),
    // A session's sandboxes and VMs, for its _meta.biscotti.chats.
    records: (session: string) => Object.fromEntries(of(session).map((row) => [`ahp-chat:/${session}/${row.id}`, record(row)])),
    // Task `id`'s conversation was just made: its chat follows it from here.
    started(id: number, conversation: ConversationId) {
      conversations.set(id, conversation);
      const row = rows.get(id);
      if (row) opts.changed(sessionOf(row));
    },
    async send(key: string, text: string) {
      if (rowOf(key)?.kind === "vm") return "this is a VM to ssh into; it takes no messages";
      const { told } = (await opts.method("tell", { id: Number(key), message: text })) as { told: string };
      return told === "none" ? `#${key} isn't running or kept any more: start a new task for this` : undefined;
    },
    cancel: async (key: string) => void (await opts.method("stop", { id: Number(key) })),
    async dispose(key: string) {
      if (rowOf(key)?.kind === "vm") await opts.method("vms.close", { sessionId: key, discard: true });
      await opts.method("remove", { id: Number(key) });
    },
    // The apps' methods (x-biscotti/<name>), passed to the gate; a VM's come back with its chat.
    methods: {
      "x-biscotti/watch": async (p: Record<string, unknown>) => opts.method("watch", { id: Number(String(p.channel).split("/").at(-1)) }),
      "x-biscotti/github": async (p: Record<string, unknown>) => {
        const { status, body } = (await opts.method("github", { path: p.path })) as { status: number; body: unknown };
        return { status, body: JSON.stringify(body) };
      },
      "x-biscotti/devices.register": async (p: Record<string, unknown>) => opts.method("devices.register", p),
      "x-biscotti/vms.open": async (p: Record<string, unknown>) => {
        const vm = (await opts.method("vms.open", { key: p.key, repo: p.repo, where: p.where })) as { id: number };
        return { ...vm, channel: `ahp-chat:/main/${vm.id}` };
      },
      "x-biscotti/vms.reopen": async (p: Record<string, unknown>) => opts.method("vms.reopen", { sessionId: String(p.id ?? String(p.channel).split("/").at(-1)), key: p.key }),
      // Deleted for good (`discard`), its chat goes too.
      "x-biscotti/vms.close": async (p: Record<string, unknown>) => {
        const id = Number(p.id ?? String(p.channel).split("/").at(-1));
        const closed = await opts.method("vms.close", { sessionId: String(id), discard: Boolean(p.discard) });
        if (p.discard) await opts.method("remove", { id });
        return closed;
      },
    } as Record<string, (params: Record<string, unknown>) => Promise<unknown>>,
  };
}
