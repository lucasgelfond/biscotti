import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatReducer, PROTOCOL_VERSION, type URI } from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { afterAll, expect, test } from "vitest";
import WebSocket from "ws";
import { model } from "./stand-in-model.ts";
import { standInVms } from "./stand-in-vm.ts";
import { until } from "./wait.ts";

// A task as the main agent runs it (agent-tasks.ts): the owner asks, the main agent starts a task, the gate sets up a
// VM and hands the run to the agent, whose task conversation runs a command in the VM through pi-env (the env pipe
// through the gate's socket), and the report comes back to the owner. The VM is a stand-in (stand-in-vm.ts): pi-env's
// own daemon on this machine.

const { boot } = await import("./support.ts");
afterAll(() => void model.close());

const stand = await standInVms([1]);
const vms = stand.host;
const set = stand.setups;
afterAll(() => stand.close());


test("the main agent runs a task in its VM through pi-env and reports back", async () => {
  const { say, sent } = await boot([], { vms: vms });
  await say("start a task: run `echo hi-from-the-vm > made-here.txt && cat made-here.txt`");
  // The gate set the VM up with its own key, for pi-env over ssh.
  await until(() => set.length > 0);
  expect((set[0] as { box: { key: string } }).box.key).toMatch(/^ssh-ed25519 \S+ biscotti-gate$/);
  // The task's command ran in the VM (it wrote the file, then read it back), and its report came back to the owner.
  await until(() => sent.some((s) => s.includes("Task report")));
  const report = sent.find((s) => s.includes("Task report"))!;
  expect(report).toContain("done: hi-from-the-vm");
}, 120_000);

// The owner's app, over AHP: the task is a sandbox chat of the session that started it, its turns the task's own.

test("the app sees a task as a sandbox chat of its session, with the task's own turns", async () => {
  const { say, sockets } = await boot([], { vms: vms });
  await say("hello");
  const ws = new WebSocket(`ws+unix://${sockets}/agent.sock:/ahp`);
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const c = new AhpClient(WebSocketTransport.fromSocket(ws as never));
  c.connect();
  await c.initialize({ clientId: "app", protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: ["ahp-root://"] });
  const { result, subscription } = await c.subscribe("ahp-session:/main");
  const session = { state: result.snapshot!.state as { chats: { resource: string }[]; _meta?: { biscotti?: { chats?: Record<string, { kind: string; status: string }> } } } };
  void (async () => {
    for await (const event of subscription) {
      if (event.type !== "action") continue;
      const a = event.params.action as { type: string; summary?: { resource: string }; _meta?: typeof session.state._meta };
      if (a.type === "session/chatAdded") session.state.chats.push(a.summary!);
      if (a.type === "session/metaChanged") session.state._meta = a._meta;
    }
  })();

  await say("start a task: run `echo seen-in-the-app`");
  await until(() => session.state.chats.some((ch) => /^ahp-chat:\/main\/\d+$/.test(ch.resource)));
  const sandbox = session.state.chats.find((ch) => /^ahp-chat:\/main\/\d+$/.test(ch.resource))!.resource as URI;
  await until(() => session.state._meta?.biscotti?.chats?.[sandbox]?.status === "done");
  expect(session.state._meta?.biscotti?.chats?.[sandbox]?.kind).toBe("sandbox");

  const chat = await c.subscribe(sandbox);
  const state = chat.result.snapshot!.state as ReturnType<typeof chatReducer> & { turns: { message: { text: string; origin: { kind: string } }; responseParts: { kind: string; content?: string; toolCall?: { toolName?: string } }[] }[] };
  // The goal is the main agent's, not the owner's.
  expect(state.turns[0].message).toMatchObject({ text: "run `echo seen-in-the-app`", origin: { kind: "agent" } });
  expect(state.turns[0].responseParts.find((p) => p.kind === "toolCall")?.toolCall?.toolName).toBe("bash");
  expect(state.turns[0].responseParts.map((p) => (p as { content?: string }).content)).toContain("done: seen-in-the-app");
  // Its report reaches the main agent as biscotti's own message, not the owner's; and the session lists its chats.
  const report = async () => {
    for (let i = 0; i < 300; i++) {
      const main = await c.subscribe("ahp-chat:/main");
      const turns = (main.result.snapshot!.state as { turns: { message: { text: string; origin: { kind: string } } }[] }).turns;
      const found = turns.find((t) => t.message.text.startsWith("Task report"));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no task report in the main chat");
  };
  expect((await report()).message.origin).toEqual({ kind: "systemNotification" });
  const { items } = await c.request("listSessions", { channel: "ahp-root://" });
  expect((items.find((s) => s.resource === "ahp-session:/main") as { chats?: { resource: string }[] }).chats?.map((ch) => ch.resource)).toEqual(["ahp-chat:/main", sandbox]);
  ws.close();
}, 120_000);

test("a coding task changes the repo it's given, and its commits come back to be pushed", async () => {
  const { vms: pool } = await boot([], { vms: vms });
  const dir = mkdtempSync(join(tmpdir(), "task-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(`${dir}/greet.js`, 'export const greet = (name) => "Hello " + name;\n');
  git("add", "-A");
  git("commit", "-qm", "greet");
  git("bundle", "create", "-q", `${dir}.bundle`, "HEAD", "main");

  const result = await pool!.run("run `cd ~/repo && sed -i.bak 's/Hello /Hello, /' greet.js && rm greet.js.bak && cat greet.js`", { repo: readFileSync(`${dir}.bundle`), model: "code" });

  // The VM's setup checked it out, the task changed it, and what it left uncommitted came back as a commit.
  expect(set.at(-1)?.box.repo).toBeDefined();
  expect(result.report).toContain("Hello, ");
  expect(result.bundle).toBeDefined();
  writeFileSync(`${dir}.out.bundle`, result.bundle!);
  git("pull", "-q", "--ff-only", `${dir}.out.bundle`, "HEAD");
  expect(readFileSync(`${dir}/greet.js`, "utf8")).toContain('"Hello, " + name');
  expect(git("log", "-1", "--format=%s")).toContain("Uncommitted changes at the end of the task");
}, 120_000);
