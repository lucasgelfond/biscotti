import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { expect, test } from "vitest";
import { board as taskBoard } from "../core/src/board.ts";
import { appMethod, emit, type Vms } from "../core/src/plugin.ts";
import api from "../plugins/api/index.ts";
import { testContext } from "./support.ts";

// The task API as an ACP agent, over its HTTP transport, with a stand-in pool whose tasks call a tool and report.
test("a client starts a task as a session, follows it, lists it, and its report ends the prompt", async () => {
  let next = 40;
  const keptOpen: number[] = [];
  const vms = {
    reserve: () => ++next,
    start(goal: string, opts?: { id?: number }) {
      const id = opts?.id ?? ++next;
      emit({ id, type: "queued", goal });
      setTimeout(() => {
        emit({ id, type: "started", slot: 1, where: "local" });
        emit({ id, type: "step", tool: "browser_navigate", text: '{"url":"https://example.com"}' });
        emit({ id, type: "report", text: `done: ${goal}`, screenshot: Buffer.from("png") });
        emit({ id, type: "kept", slot: 1, where: "local" });
      }, 50);
      return id;
    },
    tell: () => "none" as const,
    stop: () => true,
    kept: () => [{ id: next, goal: "", slot: 1, at: 0 }],
    watch: async () => "https://desktop",
    keep: async (id: number) => (keptOpen.push(id), true),
  } as unknown as Vms;

  let handler: (req: IncomingMessage, res: ServerResponse) => unknown = () => {};
  const ctx = testContext({ vms, route: (_prefix, h) => (handler = h) });
  await api.start!({ ...ctx, board: taskBoard(ctx.db, vms) });
  appMethod("echo", async (params) => params);
  const server = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acp`;

  const updates: acp.SessionNotification[] = [];
  const board: { session: acp.SessionInfo }[] = [];
  const result = await acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .onNotification("_biscotti/session", (p) => p as { session: acp.SessionInfo }, ({ params }) => void board.push(params))
    .connectWith(createHttpStream(url), async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [], _meta: { biscotti: { kind: "sandbox" } } });
      const prompted = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "book a table" }] });
      const { sessions } = await ctx.request(acp.methods.agent.session.list, {});
      const watch = await ctx.request("_biscotti/watch", { sessionId });
      const echo = await ctx.request("_biscotti/echo", { a: 1 });
      return { init, sessionId, prompted, sessions, watch, echo };
    });
  server.close();

  expect(result.init.agentCapabilities?.loadSession).toBe(true);
  expect(result.sessionId).toBe("41");
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(result.sessions[0]).toMatchObject({ sessionId: "41", title: "book a table", _meta: { biscotti: { kind: "sandbox", status: "kept", report: "done: book a table" } } });
  expect(result.watch).toEqual({ url: "https://desktop" });
  // Asking to see it keeps it open.
  expect(keptOpen).toEqual([Number(result.sessionId)]);
  expect(result.echo).toEqual({ a: 1 });
  const kinds = updates.filter((u) => u.sessionId === "41").map((u) => u.update.sessionUpdate);
  expect(kinds).toContain("user_message_chunk");
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("session_info_update");
  const said = updates.flatMap((u) => (u.update.sessionUpdate === "agent_message_chunk" ? [u.update.content] : []));
  expect(said).toContainEqual({ type: "text", text: "done: book a table" });
  expect(said).toContainEqual({ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
  // The board's own stream: every change of every session, without following it.
  expect(board.map((b) => b.session._meta?.biscotti)).toContainEqual(expect.objectContaining({ status: "kept" }));
});

// A main session: a conversation of the main agent (ctx.converse), titled by what's first said in it.
test("a client starts a main session, talks to the agent there, and its steps and reply stream back", async () => {
  let next = 70;
  const said: [string, string][] = [];
  const vms = { reserve: () => ++next, kept: () => [], watch: async () => undefined } as unknown as Vms;
  const converse = async (session: string, message: string) => {
    said.push([session, message]);
    const id = Number(session);
    emit({ id, type: "told", text: message });
    emit({ id, type: "step", tool: "search_repositories", text: '{"query":"biscotti"}' });
    emit({ id, type: "step", text: "Opening a PR on lucasgelfond/biscotti." });
    emit({ id, type: "status", model: "anthropic/claude-opus-5-5", thinking: "medium", used: 12000, size: 200000 });
    emit({ id, type: "replied" });
  };
  let handler: (req: IncomingMessage, res: ServerResponse) => unknown = () => {};
  const ctx = testContext({ vms, converse, route: (_prefix, h) => (handler = h) });
  await api.start!({ ...ctx, board: taskBoard(ctx.db, vms) });
  const server = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acp`;

  const updates: acp.SessionNotification[] = [];
  const result = await acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .connectWith(createHttpStream(url), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [], _meta: { biscotti: { source: { app: "concourse", device: "phone" } } } });
      const prompted = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "make a PR on biscotti" }] });
      const { sessions } = await ctx.request(acp.methods.agent.session.list, {});
      return { sessionId, prompted, session: sessions.find((s) => s.sessionId === sessionId) };
    });
  server.close();

  expect(said).toEqual([["71", "make a PR on biscotti"]]);
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(result.session).toMatchObject({ title: "make a PR on biscotti", _meta: { biscotti: { kind: "main", status: "done", source: { app: "concourse", device: "phone" } } } });
  const mine = updates.filter((u) => u.sessionId === "71").map((u) => u.update);
  expect(mine.map((u) => u.sessionUpdate)).toEqual(expect.arrayContaining(["user_message_chunk", "tool_call", "agent_message_chunk", "available_commands_update", "usage_update", "config_option_update"]));
  expect(mine.find((u) => u.sessionUpdate === "usage_update")).toMatchObject({ used: 12000, size: 200000 });
  expect(mine.find((u) => u.sessionUpdate === "config_option_update")).toMatchObject({ configOptions: [{ category: "model", currentValue: "anthropic/claude-opus-5-5" }, { category: "thought_level", currentValue: "medium" }] });
  expect(result.session?._meta?.biscotti).toMatchObject({ model: "anthropic/claude-opus-5-5", used: 12000 });
});

// A follower of a main session (another device) sees it go working and back to idle when someone else prompts it.
test("a session's follower sees its status change when another client prompts it", async () => {
  let next = 90;
  const vms = { reserve: () => ++next, kept: () => [], watch: async () => undefined } as unknown as Vms;
  const converse = async (session: string, message: string) => {
    const id = Number(session);
    emit({ id, type: "told", text: message });
    await new Promise((r) => setTimeout(r, 200));
    emit({ id, type: "step", text: "hi" });
    emit({ id, type: "replied" });
  };
  let handler: (req: IncomingMessage, res: ServerResponse) => unknown = () => {};
  const ctx = testContext({ vms, converse, route: (_prefix, h) => (handler = h) });
  await api.start!({ ...ctx, board: taskBoard(ctx.db, vms) });
  const server = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acp`;
  const init = { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} };

  // One client makes the session; a second follows it (session/load) while the first prompts it.
  const seen: string[] = [];
  let sessionId = "";
  let followed!: () => void;
  const following = new Promise<void>((r) => (followed = r));
  const follower = acp
    .client({ name: "follower" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const u = params.update;
      if (params.sessionId === sessionId && u.sessionUpdate === "session_info_update") seen.push(String((u._meta?.biscotti as { status?: string })?.status));
      if (params.sessionId === sessionId && u.sessionUpdate === "agent_message_chunk") seen.push("text");
    })
    .connectWith(createHttpStream(url), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, init);
      while (!sessionId) await new Promise((r) => setTimeout(r, 10));
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: "/", mcpServers: [] });
      followed();
      while (!seen.includes("done")) await new Promise((r) => setTimeout(r, 20));
    });
  await acp.client({ name: "prompter" }).connectWith(createHttpStream(url), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, init);
    sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] })).sessionId;
    await following;
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
  });
  await follower;
  server.close();
  expect(seen).toEqual(expect.arrayContaining(["running", "text", "done"]));
});
