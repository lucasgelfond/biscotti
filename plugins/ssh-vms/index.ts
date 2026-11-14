import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { emit, endpoints, secret, vmEndpoint, type Context, type Plugin, type Vm } from "@biscotti/core";
import { extension } from "../api/index.ts";

// ssh VMs: a task VM the owner works in over ssh with their own pi (core/vm/task/box-pi), from Concourse or the app,
// rather than one run of the task agent. Closed, it's kept (suspended) to open again. SSH_VM_WARM_REPO (owner/name),
// SSH_VM_WARM_COUNT (1) and SSH_VM_WARM_SETUP keep some checked out and set up ahead of time. Each is a session of the
// api plugin's ACP agent (kind "vm", its ssh address, host key and Preview in _meta.biscotti), with these methods:
//
//   _biscotti/vms/open    {key, repo?, base?, setup?}: one to ssh into -> SshVm
//   _biscotti/vms/reopen  {sessionId, key}: a closed one open again, adding that key -> SshVm
//   _biscotti/vms/close   {sessionId, discard?}: closed (kept, to open again), or deleted for good

interface SshVm {
  id: number;
  slot: number;
  repo?: string;
  where: "local" | "cloud";
  ssh: { host: string; port: number; user: string };
  // The VM's own ssh host key, for the client's known_hosts.
  hostKey?: string;
  preview?: string;
  opened: number;
}

const KEY = /^(ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+( .*)?$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SETUP_TIMEOUT_MS = 30 * 60_000;
const where = (slot: number) => (endpoints.has(slot) ? "cloud" : "local");
// This machine's VMs' sshd is on the tailnet at 2200 + slot (`tailscale serve`, nix/setup.nix); another host's is its
// endpoint for port 22.
const sshOf = (slot: number) =>
  endpoints.has(slot) || !process.env.TAILNET_HOST ? { ...vmEndpoint(slot, 22), user: "cua" } : { host: process.env.TAILNET_HOST, port: 2200 + slot, user: "cua" };

// The owner's repo as a git bundle, with GitHub's token (the github plugin's).
async function bundle(ctx: Context, repo: string, base?: string) {
  if (!REPO.test(repo)) throw new Error("the repo should be owner/name");
  const token = process.env.GITHUB_TOKEN || secret(ctx.db, "GitHub")?.token;
  if (!token) throw new Error("GitHub isn't connected, so biscotti can't check the repo out (github_connect)");
  const dir = mkdtempSync(join(tmpdir(), "ssh-vm-"));
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`, ...args], { cwd: dir });
  try {
    await git("clone", "-q", "--depth", "1000", ...(base ? ["--branch", base] : []), `https://github.com/${repo}.git`, "repo");
    await git("-C", "repo", "bundle", "create", "-q", join(dir, "in.bundle"), "HEAD");
    return readFileSync(join(dir, "in.bundle"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The VM's task agent (core/vm/task/biscotti-task) sets it up: the key authorized, the repo checked out, the setup
// command run. It answers with the VM's host key.
function prepare(vm: Vm, message: { key?: string; repo?: Buffer; setup?: string }, onLine?: (line: string) => void) {
  const { host, port } = vmEndpoint(vm.slot, 4000);
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.end(JSON.stringify({ box: { key: message.key, repo: message.repo?.toString("base64"), setup: message.setup } })));
    const timer = setTimeout(() => socket.destroy(new Error("setting up the VM took too long")), SETUP_TIMEOUT_MS);
    let done = false;
    createInterface({ input: socket, crlfDelay: Infinity })
      .on("error", () => {})
      .on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "setup" && event.line) onLine?.(event.line);
          if (event.type !== "box") return;
          done = true;
          clearTimeout(timer);
          if (event.ok) resolve(event.hostKey);
          else reject(new Error(event.error ?? "the VM couldn't be set up"));
        } catch {}
      });
    socket.on("error", (err) => (clearTimeout(timer), reject(err)));
    socket.on("close", () => (clearTimeout(timer), done || reject(new Error("the VM closed the connection"))));
  });
}

export default {
  async start(ctx) {
    if (!ctx.vms) return;
    const vms = ctx.vms;
    const open = new Map<number, SshVm>();
    const warmRepo = process.env.SSH_VM_WARM_REPO;
    const warmSetup = process.env.SSH_VM_WARM_SETUP || undefined;
    const warmCount = warmRepo ? Number(process.env.SSH_VM_WARM_COUNT ?? 1) : 0;
    const ready: { id: number; vm: Vm }[] = [];
    let warming = 0;

    const describe = async (id: number, vm: Vm, repo?: string, hostKey?: string): Promise<SshVm> => ({
      id,
      slot: vm.slot,
      repo,
      hostKey,
      where: where(vm.slot),
      ssh: sshOf(vm.slot),
      preview: await vms.watch(id).catch(() => undefined),
      opened: Date.now(),
    });
    const shown = (s: SshVm, text: string) => emit({ id: s.id, type: "started", kind: "vm", goal: `VM${s.repo ? ` on ${s.repo}` : ""}`, slot: s.slot, where: s.where, repo: s.repo, ssh: s.ssh, hostKey: s.hostKey, preview: s.preview, text });

    function warmUp() {
      while (ready.length + warming < warmCount) {
        warming++;
        void (async () => {
          let held: { id: number; vm: Vm } | undefined;
          try {
            held = await vms.hold(`VM on ${warmRepo}`, { model: "code" });
            await prepare(held.vm, { repo: await bundle(ctx, warmRepo!), setup: warmSetup });
            ready.push(held);
          } catch (err) {
            console.error(`warming a VM of ${warmRepo}: ${(err as Error).message}`);
            if (held) await vms.drop(held.id).catch(() => {});
            await new Promise((r) => setTimeout(r, 5 * 60_000));
          } finally {
            warming--;
          }
          warmUp();
        })();
      }
    }
    warmUp();

    async function openVm(request: { key: string; repo?: string; base?: string; setup?: string }) {
      if (!KEY.test(request.key.trim())) throw new Error("that isn't an ssh public key");
      const warm = request.repo && request.repo === warmRepo && !request.base && !request.setup ? ready.shift() : undefined;
      if (warm) warmUp();
      const goal = `VM${request.repo ? ` on ${request.repo}` : ""}`;
      const repo = !warm && request.repo ? await bundle(ctx, request.repo, request.base) : undefined;
      const { id, vm } = warm ?? (await vms.hold(goal, { model: "code" }));
      try {
        emit({ id, type: "queued", kind: "vm", goal, repo: request.repo });
        const hostKey = await prepare(vm, { key: request.key, repo, setup: warm ? undefined : request.setup }, (line) => emit({ id, type: "step", tool: "setup", text: line.slice(0, 300) }));
        const s = await describe(id, vm, request.repo, hostKey);
        open.set(id, s);
        shown(s, warm ? "Ready (warm)" : "Ready");
        return s;
      } catch (err) {
        await vms.drop(id).catch(() => {});
        emit({ id, type: "failed", text: (err as Error).message });
        throw err;
      }
    }
    async function close(id: number) {
      if (!open.delete(id)) return false;
      await vms.give(id);
      return true;
    }

    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    extension("_biscotti/vms/open", async ({ key, repo, base, setup }, signal) => {
      if (typeof key !== "string") throw new Error("an ssh public key, please");
      const s = await openVm({ key, repo: str(repo), base: str(base), setup: str(setup) });
      // One whose asker went away before it was ready (an app sent to the background) is closed, so it's kept to
      // open again rather than left open with no one on it.
      if (signal.aborted) await close(s.id);
      return s;
    });
    extension("_biscotti/vms/reopen", async ({ sessionId, key }) => {
      const id = Number(sessionId);
      if (typeof key !== "string" || !KEY.test(key.trim())) throw new Error("an ssh public key, please");
      const already = open.get(id);
      const repo = already?.repo ?? vms.kept().find((k) => k.id === id)?.goal.match(/ on (.+)$/)?.[1];
      const vm = already ? undefined : await vms.reclaim(id, { model: "code" });
      if (!already && !vm) throw new Error(`no VM #${id} kept`);
      const hostKey = await prepare(vm ?? { slot: already!.slot, stop: async () => {} }, { key });
      const s = already ? { ...already, hostKey: hostKey ?? already.hostKey } : await describe(id, vm!, repo, hostKey);
      open.set(id, s);
      if (!already) shown(s, "Reopened");
      return s;
    });
    extension("_biscotti/vms/close", async ({ sessionId, discard }) => {
      const id = Number(sessionId);
      const closed = await close(id);
      return { closed, discarded: discard ? await vms.forget(id) : false };
    });
  },
} satisfies Plugin;
