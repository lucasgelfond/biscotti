import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import { DescribeInstancesCommand, EC2Client, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { emit, vmEndpoint, type Host, type Plugin, type Vm, type Vms } from "@biscotti/core";
import { extension } from "../api/index.ts";

// External VM nodes: EC2 machines (nested virtualization) that each run one task VM, used only once this machine's
// slots are taken. They're launched from the `biscotti-node` launch template (setup.sh), at most NODE_MAX, started when
// needed and stopped after NODE_IDLE_MIN idle minutes, never terminated, so each keeps its disk (kept VMs) and its
// Tailscale name. Node k is biscotti-node-k on the tailnet and runs slot 100 + k (nix/node.nix), whose VM ports it
// forwards as they are (sshd at 2222); the VM reaches this gate at <this machine's Tailscale address>:18000 + slot.
//
// Settings: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (the biscotti-gate IAM user setup.sh makes), NODE_MAX
// (4), TAILNET_HOST (this machine's Tailscale name, for the tailnet's).
//
// _biscotti/tasks/move {sessionId}, on the api plugin's ACP agent, carries a task on in an external VM: its files,
// commits and conversation (a VM's memory can't move between CPUs, so open pages and running processes don't come).

const VMS_PORT = 7400;
const IDLE_MS = Number(process.env.NODE_IDLE_MIN ?? 15) * 60_000;
// A new node builds its VM image and snapshot first.
const UP_TIMEOUT_MS = 30 * 60_000;
const MAX_PACK = 1_500_000_000;

export function nodes(): Host | undefined {
  const region = process.env.AWS_REGION;
  const tailnet = process.env.TAILNET_HOST?.split(".").slice(1).join(".");
  if (!region || !process.env.AWS_ACCESS_KEY_ID || !tailnet) return undefined;
  const ec2 = new EC2Client({ region });
  const max = Number(process.env.NODE_MAX ?? 4);
  const k = (slot: number) => slot - 100;
  const name = (slot: number) => `biscotti-node-${k(slot)}.${tailnet}`;
  const vms = async (slot: number, method: string, path: string) => {
    const res = await fetch(`http://${name(slot)}:${VMS_PORT}${path}`, { method, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`${name(slot)}${path}: ${res.status} ${await res.text()}`);
    return res.text();
  };
  const alive = (slot: number) => vms(slot, "GET", "/vms/0").then(() => true, (err: Error) => / 404 /.test(err.message));

  // Node k's instance, found by its tag.
  const instance = async (slot: number) => {
    const out = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "tag:biscotti-node-index", Values: [String(k(slot))] }, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }] }));
    return out.Reservations?.flatMap((r) => r.Instances ?? [])[0]?.InstanceId;
  };
  async function launch(slot: number) {
    console.log(`launching biscotti-node-${k(slot)}`);
    const tags = [{ Key: "biscotti-role", Value: "node" }, { Key: "biscotti-node-index", Value: String(k(slot)) }, { Key: "Name", Value: `biscotti-node-${k(slot)}` }];
    await ec2.send(new RunInstancesCommand({ LaunchTemplate: { LaunchTemplateName: "biscotti-node" }, MinCount: 1, MaxCount: 1, TagSpecifications: [{ ResourceType: "instance", Tags: tags }] }));
  }

  // The node running and answering, launched or started as needed; shared by everything that needs it at once.
  const peers = new Map<number, string>();
  const starting = new Map<number, Promise<void>>();
  const up = (slot: number) => {
    let p = starting.get(slot);
    if (!p) {
      p = (async () => {
        if (!(await alive(slot))) {
          const id = await instance(slot);
          if (id) await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
          else await launch(slot);
          for (const until = Date.now() + UP_TIMEOUT_MS; !(await alive(slot)); await new Promise((r) => setTimeout(r, 10_000))) {
            if (Date.now() > until) throw new Error(`biscotti-node-${k(slot)} didn't come up in time`);
          }
        }
        peers.set(slot, (await lookup(name(slot), { family: 4 })).address);
      })().finally(() => starting.delete(slot));
      starting.set(slot, p);
    }
    return p;
  };
  // Stopped once its VM has been put away for IDLE_MS (kept VMs stay on its disk).
  const idle = new Map<number, ReturnType<typeof setTimeout>>();
  const later = (slot: number) =>
    idle.set(
      slot,
      setTimeout(async () => {
        const id = await instance(slot).catch(() => undefined);
        if (id) await ec2.send(new StopInstancesCommand({ InstanceIds: [id] })).catch((err) => console.error(err.message));
      }, IDLE_MS),
    );
  const vm = (slot: number): Vm => ({
    slot,
    stop: () => vms(slot, "DELETE", "/vms/1").then(() => void later(slot)),
    suspend: (id) => vms(slot, "POST", `/vms/1/suspend/${id}`).then(() => void later(slot)),
  });
  const onNode = async (slot: number, path: string) => (clearTimeout(idle.get(slot)), await up(slot), await vms(slot, "POST", path), vm(slot));
  const here = networkInterfaces().tailscale0?.find((a) => a.family === "IPv4")?.address;
  if (!here) console.error("no Tailscale address here: external VM nodes can't reach the gate");

  return {
    slots: Array.from({ length: max }, (_, i) => 101 + i),
    overflow: true,
    restore: (slot) => onNode(slot, "/vms/1"),
    resume: (slot, id) => onNode(slot, `/vms/1/resume/${id}`),
    discard: async (slot, id) => void ((await alive(slot)) && (await vms(slot, "DELETE", `/vms/1/suspended/${id}`))),
    endpoint: (slot, port) => ({ host: name(slot), port: port === 22 ? 2222 : port }),
    gate: (slot) => ({ host: here ?? "127.0.0.1", port: 18000 + slot, peer: () => peers.get(slot) }),
    watch: async (slot) => `https://${name(slot)}:10441/biscotti.html#password=${(await vms(slot, "GET", "/vnc-password").catch(() => "")).trim()}`,
  };
}

// A task moved from this machine into an external VM: stopped if it's running, its home folder (without caches like
// node_modules) and conversation taken out of its kept VM, then carried on there.
async function move(vms: Vms, external: number[], id: number) {
  if (vms.stop(id)) for (let i = 0; i < 600 && vms.running().some((t) => t.id === id); i++) await new Promise((r) => setTimeout(r, 100));
  const kept = vms.kept().find((t) => t.id === id);
  if (!kept) throw new Error(`task #${id} isn't kept here to move`);
  if (external.includes(kept.slot)) throw new Error(`task #${id} is already in the cloud`);
  emit({ id, type: "moving", text: "Packing it up" });
  const vm = await vms.reclaim(id);
  if (!vm) throw new Error(`task #${id} isn't kept here to move`);
  let packed: { tar: string; transcript: string; base?: string };
  try {
    packed = await new Promise((resolve, reject) => {
      const { host, port } = vmEndpoint(vm.slot, 4000);
      const socket = connect({ host, port }, () => socket.end(JSON.stringify({ export: true })));
      let received = 0;
      let got: typeof packed | undefined;
      socket.on("data", (d: Buffer) => (received += d.length) > MAX_PACK && socket.destroy(new Error("the task's files are too big to move")));
      createInterface({ input: socket, crlfDelay: Infinity }).on("error", () => {}).on("line", (line) => {
        try {
          const e = JSON.parse(line);
          if (e.type === "export") got = { tar: e.tar, transcript: e.transcript ?? "", base: e.base };
        } catch {}
      });
      socket.on("error", reject).on("close", () => (got ? resolve(got) : reject(new Error("the VM sent nothing to move"))));
    });
  } finally {
    await vms.drop(id);
  }
  emit({ id, type: "moving", text: `Packed ${Math.round((packed.tar.length * 3) / 4 / 1e6)} MB; starting it in the cloud` });
  vms.start(kept.goal, { id, fits: (slot) => external.includes(slot), extra: { moved: packed } });
}

export default {
  async start(ctx) {
    const host = nodes();
    if (!ctx.vms || !host) return;
    const vms = ctx.vms;
    await vms.addHost(host);
    extension("_biscotti/tasks/move", async ({ sessionId }) => {
      const id = Number(sessionId);
      void move(vms, host.slots, id).catch((err) => emit({ id, type: "failed", text: `Moving it failed: ${err.message}` }));
      return { moving: true };
    });
  },
} satisfies Plugin;
