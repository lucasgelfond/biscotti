import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { afterAll, expect, test } from "vitest";
import WebSocket from "ws";
import { model } from "./stand-in-model.ts";
import { standInVms } from "./stand-in-vm.ts";
import { until } from "./wait.ts";

// biscotti over the Agent Client Protocol, as the Zellij plugin reaches it: through the gate's port on the tailnet (the
// owner's login on each request, as `tailscale serve` sets it), over a WebSocket or Streamable HTTP, with the ACP SDK's
// own client; the real gate and agent, a scripted model, and stand-in VMs.

const free = createServer().listen(0, "127.0.0.1");
await once(free, "listening");
const port = (free.address() as AddressInfo).port;
free.close();
Object.assign(process.env, { API_PORT: String(port), API_OWNER: "owner@github" });

const { boot } = await import("./support.ts");
afterAll(() => void model.close());
const stand = await standInVms([1]);
afterAll(() => stand.close());
const { say, sent, db } = await boot(["ssh-vms"], { vms: stand.host });

const owner = { "tailscale-user-login": "owner@github" };
type Updates = acp.SessionNotification[];
// An ACP client for the length of `op`, its session updates as they come.
function connect<T>(transport: "http" | "ws", op: (c: acp.ClientContext, updates: Updates) => Promise<T>, headers: Record<string, string> = owner) {
  const updates: Updates = [];
  const stream =
    transport === "http"
      ? createHttpStream(`http://127.0.0.1:${port}/acp`, { headers })
      : createWebSocketStream(`ws://127.0.0.1:${port}/acp`, { headers, WebSocket: WebSocket as never });
  return acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .connectWith(stream, async (c) => {
      await c.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      return op(c, updates);
    });
}
const texts = (updates: Updates, sessionId: string, kind = "agent_message_chunk") =>
  updates.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === kind).map((u) => ((u.update as { content?: { text?: string } }).content?.text ?? "").replace(/^\[[^\]]*\] /, ""));

for (const transport of ["ws", "http"] as const) {
  test(`over ${transport === "ws" ? "a WebSocket" : "Streamable HTTP"}: the owner's texts as a session, a new session's turn with a tool call, and a text arriving while it's open`, async () => {
    await say(`hello over ${transport}`);
    await connect(transport, async (c, updates) => {
      const { sessions } = await c.request(acp.methods.agent.session.list, {});
      expect(sessions.find((s) => s.sessionId === "main")?.title).toBe("Texts");

      // Loading the texts replays what was said in them.
      await c.request(acp.methods.agent.session.load, { sessionId: "main", cwd: "/", mcpServers: [] });
      expect(texts(updates, "main", "user_message_chunk")).toContain(`hello over ${transport}`);
      expect(texts(updates, "main").join("")).toContain(`echo: hello over ${transport}`);

      // A text from the owner shows in the open session as it happens.
      const seen = updates.length;
      await say(`and hi from my phone over ${transport}`);
      await until(() => texts(updates.slice(seen), "main").join("").includes(`echo: and hi from my phone over ${transport}`));
      expect(texts(updates.slice(seen), "main", "user_message_chunk")).toContain(`and hi from my phone over ${transport}`);

      // A prompt from the app in the texts is answered in the app, not in the owner's iMessage thread.
      const before = sent.length;
      const { stopReason } = await c.request(acp.methods.agent.session.prompt, { sessionId: "main", prompt: [{ type: "text", text: `from the multiplexer over ${transport}` }] });
      expect(stopReason).toBe("end_turn");
      expect(texts(updates, "main").join("")).toContain(`echo: from the multiplexer over ${transport}`);
      expect(sent.slice(before).join("\n")).not.toContain("from the multiplexer");

      // A session of its own: a turn with a tool call, which does what it says.
      const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
      const fact = `the sky is blue over ${transport}`;
      expect((await c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: `remember ${fact}` }] })).stopReason).toBe("end_turn");
      expect(updates.some((u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && u.update.title === "remember")).toBe(true);
      expect((db.$client.prepare("SELECT content FROM memories").all() as { content: string }[]).map((m) => m.content)).toContain(fact);
      const listed = (await c.request(acp.methods.agent.session.list, {})).sessions.find((s) => s.sessionId === sessionId);
      expect(listed?.title).toBe(`remember ${fact}`);
    });
  }, 120_000);
}

// As the Zellij plugin opens a VM to ssh into: _biscotti/vms/open (the app's x-biscotti/vms.open), its chat a session
// under the texts, closed and kept, reopened, then deleted.
test("a VM opened, kept, reopened and deleted through biscotti's own ACP methods", async () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnerKeyForTheAcpSuite owner@test";
  await connect("ws", async (c) => {
    const vm = (await c.request("_biscotti/vms/open", { key })) as { id: number; hostKey?: string; ssh: { port: number } };
    expect(vm.hostKey).toMatch(/^ssh-ed25519 /);
    const listed = async () => (await c.request(acp.methods.agent.session.list, {})).sessions.find((s) => s.sessionId === `main/${vm.id}`);
    expect((await listed())?._meta?.["pi-durable"]).toMatchObject({ parent: "main" });
    await c.request("_biscotti/vms/close", { id: vm.id, discard: false });
    const again = (await c.request("_biscotti/vms/reopen", { id: vm.id, key })) as { id: number };
    expect(again.id).toBe(vm.id);
    expect(((await c.request("_biscotti/vms/close", { id: vm.id, discard: true })) as { discarded: boolean }).discarded).toBe(true);
    const end = Date.now() + 10_000;
    while ((await listed()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(await listed()).toBeUndefined();
  });
}, 240_000);

test("without the owner's login, neither transport gets through", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/acp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(403);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, { headers: { "tailscale-user-login": "someone-else@github" } });
  const [err] = (await once(ws, "error")) as [Error];
  expect(err.message).toContain("403");
});
