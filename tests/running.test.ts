import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createGate } from "../core/src/gate.ts";
import { localTools, text, type Caller } from "../core/src/plugin.ts";

// The task pool's bookkeeping with stand-in VMs: what's running, stopping one, and when a task counts as quiet. Read
// before tasks.ts loads.
process.env.TASK_IDLE_MS = "400";
process.env.VM_SLOTS = "2";
const { taskVms, taskTools } = await import("../core/src/tasks.ts");

// A task agent: "silent" says nothing, "wait <ms>" says nothing for that long and then reports, anything else is
// reported at once.
async function agent() {
  // Half-open, as the VM's agent is: the goal ends the gate's side, the report comes back after.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let goal = "";
    socket.on("data", (d) => (goal += d)).on("error", () => {});
    socket.on("end", async () => {
      const said = JSON.parse(goal).goal as string;
      if (said === "silent") return;
      const wait = Number(said.match(/^wait (\d+)/)?.[1] ?? 0);
      await new Promise((r) => setTimeout(r, wait));
      socket.end(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `done: ${said}` }] } })}\n`);
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
}

async function pool(busy: (slot: number) => boolean = () => false) {
  const address = await agent();
  return taskVms(async (slot) => ({ slot, address, stop: async () => {} }), busy);
}

const until = async (check: () => boolean) => {
  while (!check()) await new Promise((r) => setTimeout(r, 10));
};

test("lists running and queued tasks, and stopping one frees its slot for the queued one", async () => {
  const vms = await pool(() => true);
  const runs = ["silent", "silent", "silent"].map((goal) => vms.run(goal).catch((err: Error) => err.message));
  await until(() => vms.running().filter((t) => t.slot).length === 2);

  expect(vms.running().map(({ id, slot }) => ({ id, slot }))).toEqual([{ id: 1, slot: 1 }, { id: 2, slot: 2 }, { id: 3, slot: undefined }]);
  expect(vms.stop(1)).toBe(true);
  expect(await runs[0]).toBe("the task was stopped");
  await until(() => vms.running().find((t) => t.id === 3)?.slot !== undefined);
  expect(vms.running().map((t) => t.id)).toEqual([2, 3]);
  expect(vms.stop(99)).toBe(false);
  vms.stop(2);
  vms.stop(3);
});

test("a task in a tool call (like waiting on the owner's yes) isn't quiet; one that's only silent is", async () => {
  let inToolCall = true;
  const vms = await pool(() => inToolCall);

  expect((await vms.run("wait 1200")).report).toBe("done: wait 1200");
  inToolCall = false;
  await expect(vms.run("silent")).rejects.toThrow("the task went quiet");
});

test("starting a task names the ones still running, and the main agent can list and stop them", async () => {
  const vms = await pool(() => true);
  const reports: string[] = [];
  const tools = localTools(taskTools(vms, (_goal, { report }) => reports.push(report), undefined, () => "in vault_fill for 3 min"));
  const said = async (name: string, args: Record<string, unknown> = {}) => ((await tools.call(name, args)).content[0] as { text: string }).text;

  await said("task", { goal: "silent" });
  await until(() => vms.running()[0]?.slot !== undefined);
  const second = await said("task", { goal: "Buy 2 tickets" });

  expect(second).toContain("Also running");
  expect(second).toContain("#1 (0 min, in vault_fill for 3 min): silent");
  expect(await said("running_tasks")).toContain("#2");
  expect(await said("stop_task", { id: 1 })).toBe("Stopped #1.");
  await until(() => reports.length === 2);
  expect(reports).toContain("The task failed: the task was stopped");
  expect(await said("running_tasks")).toBe("No tasks are running.");
});

test("the gate stamps a task VM's tool calls with its task, and knows the slot is mid-call", async () => {
  const gate = createGate({ llm: { url: "http://127.0.0.1:9", key: "k" }, models: {}, send: async () => {} });
  const callers: Caller[] = [];
  let finish = () => {};
  gate.add({ ...localTools([]), tasks: localTools([{ name: "slow", description: "", input: { type: "object" }, run: async (_a, caller) => (callers.push(caller), await new Promise<void>((r) => (finish = r)), text("ok")) }]) });
  const server = await gate.listen("127.0.0.1", 0, { slot: 1 });
  gate.assign(1, 42);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));

  const call = client.callTool({ name: "slow", arguments: {} });
  await until(() => callers.length === 1);

  expect(callers[0]).toEqual({ slot: 1, task: 42 });
  expect(gate.busy(1)?.tool).toBe("slow");
  finish();
  await call;
  expect(gate.busy(1)).toBeUndefined();
  server.close();
});
