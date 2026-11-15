import { randomUUID } from "node:crypto";
import { type ActionEnvelope, chatReducer, PROTOCOL_VERSION, type URI } from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport, type TransportFrame } from "@microsoft/agent-host-protocol/client";
import { afterAll, expect, test } from "vitest";
import WebSocket from "ws";
import { model } from "./stand-in-model.ts";

// biscotti's Agent Host Protocol host, driven by Microsoft's own AHP client, with the real gate and agent and a stand-in
// model: the catalogue, a session's chat with its history, a turn an app starts (with a tool call), a text arriving in
// the owner's iMessage thread, a new session, and a client that reconnects getting what it missed.

const { boot } = await import("./support.ts");
afterAll(() => void model.close());

// Microsoft's client over a WebSocket to the agent's socket (as the gate passes it through from the tailnet).
class Socket implements AhpTransport {
  readonly #frames: TransportFrame[] = [];
  readonly #waiting: ((frame: TransportFrame | null) => void)[] = [];
  #closed = false;
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: WebSocket.RawData) => {
      const frame: TransportFrame = { kind: "text", text: String(data) };
      const w = this.#waiting.shift();
      if (w) w(frame);
      else this.#frames.push(frame);
    });
    ws.on("close", () => {
      this.#closed = true;
      for (const w of this.#waiting.splice(0)) w(null);
    });
  }
  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  recv() {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    return this.#closed ? Promise.resolve(null) : new Promise<TransportFrame | null>((r) => this.#waiting.push(r));
  }
  close() {
    this.ws.close();
  }
}
async function client(sockets: string, id = randomUUID()) {
  const ws = new WebSocket(`ws+unix://${sockets}/agent.sock:/ahp`);
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const c = new AhpClient(new Socket(ws));
  c.connect();
  return { c, id, ws };
}
// A chat's state as a client keeps it: its snapshot, then each action through the protocol's own reducer.
async function follow(c: AhpClient, uri: URI) {
  const { result, subscription } = await c.subscribe(uri);
  const chat = { state: result.snapshot!.state as never as ReturnType<typeof chatReducer>, seen: [] as ActionEnvelope[] };
  void (async () => {
    for await (const event of subscription) {
      if (event.type !== "action") continue;
      chat.seen.push(event.params);
      chat.state = chatReducer(chat.state as never, event.params.action as never) as never;
    }
  })();
  return chat;
}
const until = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const lastTurn = (state: { turns: { message: { text: string }; responseParts: { kind: string; content?: string; toolCall?: { toolName?: string } }[]; state: string }[] }) => state.turns.at(-1)!;

test("an app sees and drives biscotti's sessions over AHP", async () => {
  const { say, sent, sockets, db } = await boot([]);
  // The owner's texts are listed before anything's said in them.
  const early = await client(sockets);
  await early.c.initialize({ clientId: early.id, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: ["ahp-root://"] });
  expect((await early.c.request("listSessions", { channel: "ahp-root://" })).items.map((s) => [s.resource, s.title])).toContainEqual(["ahp-session:/main", "Texts"]);
  early.ws.close();
  await say("hello there");
  expect(sent.at(-1)).toBe("echo: hello there");

  const { c, id, ws: first } = await client(sockets);
  const init = await c.initialize({ clientId: id, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: ["ahp-root://"] });
  expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
  const { items } = await c.request("listSessions", { channel: "ahp-root://" });
  expect(items.map((s) => [s.resource, s.title])).toContainEqual(["ahp-session:/main", "Texts"]);

  // The owner's texts as a session whose default chat already holds what was said.
  const { result: session } = await c.subscribe("ahp-session:/main");
  expect((session.snapshot!.state as { defaultChat?: URI }).defaultChat).toBe("ahp-chat:/main");
  const chat = await follow(c, "ahp-chat:/main");
  expect(lastTurn(chat.state as never).message.text).toBe("hello there");
  expect(lastTurn(chat.state as never).responseParts.map((p) => p.content)).toContain("echo: hello there");

  // A turn the app starts: its tool call, its result and its answer, then the turn complete.
  c.dispatch("ahp-chat:/main", { type: "chat/turnStarted", turnId: "t-1", startedAt: new Date().toISOString(), message: { text: "remember the sky is blue", origin: { kind: "user" } } } as never);
  await until(() => chat.seen.some((e) => (e.action.type as string) === "chat/turnComplete"));
  const turn = lastTurn(chat.state as never) as never as { message: { text: string }; responseParts: { kind: string; content?: string; toolCall?: { toolName?: string; success?: boolean } }[]; state: string };
  expect(turn.message.text).toBe("remember the sky is blue");
  expect(turn.state).toBe("complete");
  expect(turn.responseParts.find((p) => p.kind === "toolCall")?.toolCall?.toolName).toBe("remember");
  expect(turn.responseParts.map((p) => p.content)).toContain("saved");
  expect((db.$client.prepare("SELECT content FROM memories").all() as { content: string }[]).map((m) => m.content)).toContain("the sky is blue");

  // A text from the owner shows in the same chat as it happens.
  const before = chat.seen.length;
  await say("and hi from my phone");
  await until(() => chat.seen.slice(before).some((e) => (e.action.type as string) === "chat/turnComplete"));
  expect(lastTurn(chat.state as never).message.text).toBe("and hi from my phone");
  expect(lastTurn(chat.state as never).responseParts.map((p) => p.content)).toContain("echo: and hi from my phone");

  // A new session from the app: it joins the catalogue, takes a turn, and is titled by its first message.
  const fresh = `ahp-session:/${randomUUID()}`;
  await c.request("createSession", { channel: fresh } as never);
  const second = await follow(c, `ahp-chat:/${fresh.slice("ahp-session:/".length)}`);
  c.dispatch(`ahp-chat:/${fresh.slice("ahp-session:/".length)}`, { type: "chat/turnStarted", turnId: "t-2", startedAt: new Date().toISOString(), message: { text: "a brand new thread", origin: { kind: "user" } } } as never);
  await until(() => second.seen.some((e) => (e.action.type as string) === "chat/turnComplete"));
  expect(lastTurn(second.state as never).responseParts.map((p) => p.content)).toContain("echo: a brand new thread");
  const listed = (await c.request("listSessions", { channel: "ahp-root://" })).items;
  expect(listed.find((s) => s.resource === fresh)?.title).toBe("a brand new thread");

  // A client that drops and comes back gets the actions it missed, not a fresh snapshot.
  const lastSeen = chat.seen.at(-1)!.serverSeq;
  first.close();
  await say("while you were away");
  const back = await client(sockets, id);
  const resumed = await back.c.reconnect({ clientId: id, lastSeenServerSeq: lastSeen, subscriptions: ["ahp-chat:/main"] });
  expect(resumed.type).toBe("replay");
  const replayed = (resumed as { actions: ActionEnvelope[] }).actions;
  expect(replayed.some((e) => (e.action.type as string) === "chat/turnStarted" && (e.action as { message?: { text: string } }).message?.text === "while you were away")).toBe(true);
}, 90_000);
