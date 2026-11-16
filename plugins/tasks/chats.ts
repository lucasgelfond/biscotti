import type { AgentApi } from "@biscotti/core/agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Chat } from "pi-durable-ahp";
import type { Row } from "./board.ts";

// The board's tasks (sandboxes) and VMs as chats beside the session that started them (pi-durable-ahp's `chats`): a
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

// `conversation`: task `id`'s, once it has run.
export function chats(api: AgentApi, conversation: (id: number) => Promise<ConversationId | undefined>) {
  const rows = new Map<number, Row>();
  const conversations = new Map<number, ConversationId>();
  // Each session's change said once for all the board's rows that came together (a hundred at a start).
  const pending = new Set<string>();
  const changed = (session: string) => {
    if (pending.has(session)) return;
    pending.add(session);
    setImmediate(() => (pending.delete(session), api.changed(session)));
  };

  // The board's rows, every one each time the gate's link is ready, then each change (index.ts).
  api.link.on("tasks/row", (row: Row) => {
    const before = rows.get(row.id);
    if (row.kind === "gone") {
      rows.delete(row.id);
      if (before && isChat(before)) changed(sessionOf(before));
      return;
    }
    rows.set(row.id, row);
    if (!isChat(row)) return;
    if (row.kind === "sandbox" && !conversations.has(row.id))
      void conversation(row.id).then((id) => id !== undefined && (conversations.set(row.id, id), changed(sessionOf(row))), () => {});
    changed(sessionOf(row));
  });

  const of = (session: string) => [...rows.values()].filter((r) => isChat(r) && sessionOf(r) === session);
  const id = (key: string) => ({ id: Number(key) });
  return {
    list: (session: string): Chat[] =>
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
    started(id: number, made: ConversationId) {
      conversations.set(id, made);
      const row = rows.get(id);
      if (row) api.changed(sessionOf(row));
    },
    async send(key: string, text: string) {
      if (rows.get(Number(key))?.kind === "vm") return "this is a VM to ssh into; it takes no messages";
      const { told } = await api.link.request<{ told: string }>("tasks/tell", { ...id(key), message: text });
      return told === "none" ? `#${key} isn't running or kept any more: start a new task for this` : undefined;
    },
    cancel: async (key: string) => void (await api.link.request("tasks/stop", id(key))),
    dispose: async (key: string) => void (await api.link.request("tasks/remove", id(key))),
  };
}
