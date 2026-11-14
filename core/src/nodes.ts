import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { AwsClient } from "aws4fetch";
import { callHost } from "./http.ts";
import { nodeHosts, REMOTE_BASE, vmEndpoint } from "./plugin.ts";
import type { Keep, Vm } from "./tasks.ts";

// Overflow machines: EC2 instances (nested virtualization) running only task VMs, used when this machine's slots are
// busy. The gate launches them from the `biscotti-node` launch template (installer/aws/node-setup.sh), at most
// NODE_MAX, starts and stops them as needed, and never terminates them, so each keeps its disk and Tailscale name.
// Node k (1..NODE_MAX) is `biscotti-node-k` on the tailnet and holds slots 100k+1 to 100k+NODE_SLOTS.
//
// Settings: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (the biscotti-gate IAM user), TS_OAUTH_CLIENT_ID and
// TS_OAUTH_CLIENT_SECRET (a one-time Tailscale key for each new node), NODE_MAX (4), NODE_SLOTS (4).

const VMS_PORT = 7400;
// Slot S's VM reaches the gate at GATE_PORT_BASE + S on this machine's Tailscale address.
export const GATE_PORT_BASE = 18000;
const IDLE_MS = Number(process.env.NODE_IDLE_MIN ?? 15) * 60_000;
// A new node builds its VM image and snapshot first.
const UP_TIMEOUT_MS = 30 * 60_000;
const TAG = "tag:biscotti-node";
export const MAX_NODES = 4;

export interface Nodes {
  slots: number[];
  restore(slot: number): Promise<Vm>;
  keep: Keep;
  watch(slot: number): Promise<string>;
  // The node's Tailscale address, for the gate's per-slot listeners.
  peer(slot: number): string | undefined;
}

const nodeOf = (slot: number) => Math.floor(slot / REMOTE_BASE);
const local = (slot: number) => slot % REMOTE_BASE;

export function configuredNodes(dataDir?: string): Nodes | undefined {
  const region = process.env.AWS_REGION;
  const tailnet = process.env.TAILNET_HOST?.split(".").slice(1).join(".");
  if (!region || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !tailnet) return undefined;
  const max = Math.min(MAX_NODES, Number(process.env.NODE_MAX ?? MAX_NODES));
  const perNode = Number(process.env.NODE_SLOTS ?? 4);
  const aws = new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!, region });
  const indexes = Array.from({ length: max }, (_, i) => i + 1);
  const slots = indexes.flatMap((k) => Array.from({ length: perNode }, (_, i) => k * REMOTE_BASE + i + 1));
  for (const k of indexes) nodeHosts.set(k, `biscotti-node-${k}.${tailnet}`);
  const host = (k: number) => nodeHosts.get(k)!;

  // Which instance is node k, kept across restarts.
  const file = dataDir ? `${dataDir}/nodes.json` : undefined;
  const instances: Record<number, string> = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const save = () => file && writeFileSync(file, JSON.stringify(instances));
  const peers = new Map<number, string>();

  const vms = (k: number, method: string, path: string) => callHost(host(k), VMS_PORT, method, path);
  const alive = (k: number) => vms(k, "GET", "/vms/0").then(() => true, (err: Error) => /: 404 /.test(err.message));

  async function ec2(action: string, params: Record<string, string>) {
    const body = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params });
    const res = await aws.fetch(`https://ec2.${region}.amazonaws.com/`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`EC2 ${action}: ${res.status} ${text.slice(0, 300)}`);
    return text;
  }

  // A one-time, pre-approved Tailscale key for node k's first login, where only node instances can read it.
  async function tailscaleKey(k: number) {
    const id = process.env.TS_OAUTH_CLIENT_ID;
    const secret = process.env.TS_OAUTH_CLIENT_SECRET;
    if (!id || !secret) throw new Error("a new cloud machine needs TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET (installer/aws/NODE.md)");
    const token = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
    }).then((r) => r.json() as Promise<{ access_token?: string }>);
    if (!token.access_token) throw new Error("Tailscale refused the OAuth client");
    const key = await fetch("https://api.tailscale.com/api/v2/tailnet/-/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [TAG] } } },
        expirySeconds: 3600,
        description: `biscotti-node-${k}`,
      }),
    }).then((r) => r.json() as Promise<{ key?: string; message?: string }>);
    if (!key.key) throw new Error(`Tailscale didn't make a key: ${key.message ?? "no reason given"}`);
    const res = await aws.fetch(`https://ssm.${region}.amazonaws.com/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AmazonSSM.PutParameter" },
      body: JSON.stringify({ Name: `/biscotti/node/${k}/tailscale-key`, Value: key.key, Type: "SecureString", Overwrite: true }),
    });
    if (!res.ok) throw new Error(`SSM PutParameter: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  // Node instances AWS has, live or stopped, so the cap holds whatever nodes.json says.
  async function existing() {
    const xml = await ec2("DescribeInstances", {
      "Filter.1.Name": "tag:biscotti-role",
      "Filter.1.Value.1": "node",
      "Filter.2.Name": "instance-state-name",
      "Filter.2.Value.1": "pending",
      "Filter.2.Value.2": "running",
      "Filter.2.Value.3": "stopping",
      "Filter.2.Value.4": "stopped",
    });
    return [...xml.matchAll(/<instanceId>(i-[0-9a-f]+)<\/instanceId>/g)].map((m) => m[1]);
  }

  async function launch(k: number) {
    if ((await existing()).length >= max) throw new Error(`already ${max} cloud machines (NODE_MAX)`);
    await tailscaleKey(k);
    console.log(`launching cloud machine biscotti-node-${k}`);
    const xml = await ec2("RunInstances", {
      "LaunchTemplate.LaunchTemplateName": "biscotti-node",
      MinCount: "1",
      MaxCount: "1",
      "TagSpecification.1.ResourceType": "instance",
      "TagSpecification.1.Tag.1.Key": "biscotti-role",
      "TagSpecification.1.Tag.1.Value": "node",
      "TagSpecification.1.Tag.2.Key": "biscotti-node-index",
      "TagSpecification.1.Tag.2.Value": String(k),
      "TagSpecification.1.Tag.3.Key": "Name",
      "TagSpecification.1.Tag.3.Value": `biscotti-node-${k}`,
    });
    const id = /<instanceId>(i-[0-9a-f]+)<\/instanceId>/.exec(xml)?.[1];
    if (!id) throw new Error("EC2 didn't say which instance it launched");
    instances[k] = id;
    save();
  }

  // Node k running and answering, launched or started as needed; shared by every task that needs it at once.
  const starting = new Map<number, Promise<void>>();
  function up(k: number) {
    let p = starting.get(k);
    if (!p) {
      p = (async () => {
        if (await alive(k)) return;
        if (!instances[k]) await launch(k);
        else {
          console.log(`starting cloud machine biscotti-node-${k}`);
          await ec2("StartInstances", { "InstanceId.1": instances[k] });
        }
        const until = Date.now() + UP_TIMEOUT_MS;
        while (!(await alive(k))) {
          if (Date.now() > until) throw new Error(`biscotti-node-${k} didn't come up in time`);
          await new Promise((r) => setTimeout(r, 10_000));
        }
        const address = await lookup(host(k), { family: 4 }).then((r) => r.address, () => undefined);
        if (address) peers.set(k, address);
      })().finally(() => starting.delete(k));
      starting.set(k, p);
    }
    return p;
  }

  // Each node stops once nothing has used it for IDLE_MS (its kept VMs stay on its disk).
  const using = new Map<number, number>();
  const idle = new Map<number, ReturnType<typeof setTimeout>>();
  const hold = (k: number) => (using.set(k, (using.get(k) ?? 0) + 1), clearTimeout(idle.get(k)));
  const letGo = (k: number) => {
    const n = (using.get(k) ?? 1) - 1;
    using.set(k, n);
    if (n > 0 || !instances[k]) return;
    idle.set(
      k,
      setTimeout(() => {
        if ((using.get(k) ?? 0) > 0) return;
        console.log(`stopping cloud machine biscotti-node-${k}, idle for ${IDLE_MS / 60_000} minutes`);
        ec2("StopInstances", { "InstanceId.1": instances[k] }).catch((err) => console.error(err.message));
      }, IDLE_MS),
    );
  };

  const vm = (slot: number): Vm => {
    const k = nodeOf(slot);
    let held = true;
    const done = () => held && ((held = false), letGo(k));
    return {
      slot,
      address: vmEndpoint(slot, 4000),
      stop: () => vms(k, "DELETE", `/vms/${local(slot)}`).then(() => {}).finally(done),
      suspend: (id) => vms(k, "POST", `/vms/${local(slot)}/suspend/${id}`).then(() => {}).finally(done),
    };
  };
  const withNode = async <T>(slot: number, f: () => Promise<T>) => {
    const k = nodeOf(slot);
    hold(k);
    try {
      await up(k);
      return await f();
    } catch (err) {
      letGo(k);
      throw err;
    }
  };

  return {
    slots,
    restore: (slot) => withNode(slot, async () => (await vms(nodeOf(slot), "POST", `/vms/${local(slot)}`), vm(slot))),
    keep: {
      resume: (slot, id) => withNode(slot, async () => (await vms(nodeOf(slot), "POST", `/vms/${local(slot)}/resume/${id}`), vm(slot))),
      discard: async (slot, id) => {
        if (await alive(nodeOf(slot))) await vms(nodeOf(slot), "DELETE", `/vms/${local(slot)}/suspended/${id}`);
      },
    },
    watch: async (slot) =>
      `https://${host(nodeOf(slot))}:${10440 + local(slot)}/biscotti.html#password=${(await vms(nodeOf(slot), "GET", "/vnc-password").catch(() => "")).trim()}`,
    peer: (slot) => peers.get(nodeOf(slot)),
  };
}

// This machine's Tailscale address, where remote VMs reach the gate.
export function tailscaleAddress() {
  return networkInterfaces().tailscale0?.find((a) => a.family === "IPv4")?.address;
}
