import { networkInterfaces } from "node:os";
import { lookup } from "node:dns/promises";
import { existsSync, writeFileSync } from "node:fs";
import { AwsClient } from "aws4fetch";
import { callHost } from "./http.ts";
import { REMOTE_BASE, vmEndpoint } from "./plugin.ts";
import type { Keep, Vm } from "./tasks.ts";

// An overflow machine: an EC2 instance (nested virtualization) running only task VMs, started when this machine's slots
// are all busy and stopped once it has had none for a while. Its slots are numbered from 101. It holds no keys or data:
// its VMs reach the model and tools through this gate, over Tailscale, and it keeps its suspended VMs on its own disk
// (an EBS volume, kept while it's stopped). See installer/aws/NODE.md.
//
// NODE_HOST: its Tailscale name (it forwards each slot's VM ports there, plugin.ts). NODE_SLOTS: how many slots.
// NODE_INSTANCE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: to start and stop it. TS_OAUTH_CLIENT_ID and
// TS_OAUTH_CLIENT_SECRET: to give it a one-time Tailscale key the first time it starts.

const VMS_PORT = 7400;
// A remote slot's VM reaches this gate at port GATE_PORT_BASE + slot on this machine's Tailscale address.
export const GATE_PORT_BASE = 18000;
const IDLE_MS = Number(process.env.NODE_IDLE_MIN ?? 15) * 60_000;
// The first start builds the VM image and snapshot, which takes a while.
const UP_TIMEOUT_MS = 20 * 60_000;
const TAG = "tag:biscotti-node";

export interface Node {
  slots: number[];
  host: string;
  restore(slot: number): Promise<Vm>;
  keep: Keep;
  // The live desktop's link for a remote slot.
  watch(slot: number): Promise<string>;
}

export function configuredNode(dataDir?: string): Node | undefined {
  const host = process.env.NODE_HOST;
  if (!host) return undefined;
  const count = Number(process.env.NODE_SLOTS ?? 4);
  const slots = Array.from({ length: count }, (_, i) => REMOTE_BASE + i + 1);
  const region = process.env.AWS_REGION ?? "us-east-1";
  const aws = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region })
    : undefined;
  const instance = process.env.NODE_INSTANCE;
  const joined = dataDir ? `${dataDir}/node-joined` : undefined;

  const vms = (method: string, path: string) => callHost(host, VMS_PORT, method, path);
  const alive = () => vms("GET", "/vms/0").then(() => true, (err: Error) => /: 404 /.test(err.message));

  async function ec2(action: string, params: Record<string, string>) {
    const body = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params });
    const res = await aws!.fetch(`https://ec2.${region}.amazonaws.com/`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`EC2 ${action}: ${res.status} ${text.slice(0, 300)}`);
    return text;
  }

  // A one-time, pre-approved key for the node's first Tailscale login, put where its instance role can read it.
  async function tailscaleKey() {
    const id = process.env.TS_OAUTH_CLIENT_ID;
    const secret = process.env.TS_OAUTH_CLIENT_SECRET;
    if (!id || !secret) throw new Error("the overflow machine hasn't joined Tailscale, and TS_OAUTH_CLIENT_ID/SECRET aren't set");
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
        description: "biscotti overflow machine",
      }),
    }).then((r) => r.json() as Promise<{ key?: string; message?: string }>);
    if (!key.key) throw new Error(`Tailscale didn't make a key: ${key.message ?? "no reason given"}`);
    const res = await aws!.fetch(`https://ssm.${region}.amazonaws.com/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AmazonSSM.PutParameter" },
      body: JSON.stringify({ Name: "/biscotti/node/tailscale-key", Value: key.key, Type: "SecureString", Overwrite: true }),
    });
    if (!res.ok) throw new Error(`SSM PutParameter: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  // Started (if it isn't running) and answering; shared by every task that needs it at once.
  let starting: Promise<void> | undefined;
  function up() {
    return (starting ??= (async () => {
      if (await alive()) return;
      if (!aws || !instance) throw new Error("the overflow machine isn't answering, and biscotti can't start it (no AWS settings)");
      if (joined && !existsSync(joined)) await tailscaleKey();
      console.log(`starting the overflow machine ${instance}`);
      await ec2("StartInstances", { "InstanceId.1": instance });
      const until = Date.now() + UP_TIMEOUT_MS;
      while (!(await alive())) {
        if (Date.now() > until) throw new Error("the overflow machine didn't come up in time");
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (joined) writeFileSync(joined, new Date().toISOString());
    })().finally(() => (starting = undefined)));
  }

  // Stopped once nothing has used it for IDLE_MS (its suspended VMs stay on its disk).
  let using = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const hold = () => {
    using++;
    clearTimeout(idle);
  };
  const letGo = () => {
    if (--using > 0 || !aws || !instance) return;
    idle = setTimeout(() => {
      if (using > 0) return;
      console.log(`stopping the overflow machine ${instance}, idle for ${IDLE_MS / 60_000} minutes`);
      ec2("StopInstances", { "InstanceId.1": instance }).catch((err) => console.error(err.message));
    }, IDLE_MS);
  };

  const local = (slot: number) => slot - REMOTE_BASE;
  const vm = (slot: number): Vm => {
    let held = true;
    const done = () => held && ((held = false), letGo());
    return {
      slot,
      address: vmEndpoint(slot, 4000),
      stop: () => vms("DELETE", `/vms/${local(slot)}`).then(() => {}).finally(done),
      suspend: (id) => vms("POST", `/vms/${local(slot)}/suspend/${id}`).then(() => {}).finally(done),
    };
  };
  const withNode = async <T>(f: () => Promise<T>) => {
    hold();
    try {
      await up();
      return await f();
    } catch (err) {
      letGo();
      throw err;
    }
  };

  return {
    slots,
    host,
    restore: (slot) => withNode(async () => (await vms("POST", `/vms/${local(slot)}`), vm(slot))),
    keep: {
      resume: (slot, id) => withNode(async () => (await vms("POST", `/vms/${local(slot)}/resume/${id}`), vm(slot))),
      discard: async (slot, id) => {
        if (await alive()) await vms("DELETE", `/vms/${local(slot)}/suspended/${id}`);
      },
    },
    watch: async (slot) => `https://${host}:${10440 + local(slot)}/biscotti.html#password=${(await vms("GET", "/vnc-password").catch(() => "")).trim()}`,
  };
}

// This machine's Tailscale address, where remote VMs reach the gate.
export function tailscaleAddress() {
  return networkInterfaces().tailscale0?.find((a) => a.family === "IPv4")?.address;
}

// The node's Tailscale address, so only it may use its slots' gate listeners (the tailnet policy should say so too).
export const nodeAddress = (host: string) => lookup(host, { family: 4 }).then((r) => r.address, () => undefined);
