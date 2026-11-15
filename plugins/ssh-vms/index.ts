import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { appMethod, emit, endpoints, prepareVm, secret, taskEvents, vmEndpoint, type Context, type Plugin, type Vm } from "@biscotti/core";

// ssh VMs: a task VM the owner works in over ssh with their own pi (core/vm/task/box-pi), from Concourse or the app,
// rather than one run of the task agent. Closed, it's kept (suspended) to open again. SSH_VM_WARM_REPO (owner/name),
// SSH_VM_WARM_COUNT (1) and SSH_VM_WARM_SETUP keep some checked out and set up ahead of time. One stays up until it's
// closed, or until every slot is taken and something else needs one: then the one opened longest ago goes to sleep
// (closed and kept on disk, to open again). Each is on the board (kind "vm", its ssh address, host key and
// preview), and these are the apps' methods for them (core's appMethod):
//
//   vms.open    {key, repo?, base?, setup?, where?}: one to ssh into -> SshVm. `where`: "local" (this machine's VMs) or
//               "cloud" (an external VM node's); either, by default
//   vms.reopen  {sessionId, key}: a closed one open again, adding that key -> SshVm
//   vms.close   {sessionId, discard?}: closed (kept, to open again), or deleted for good

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

    // Put to sleep when its slot is needed (tasks.ts), the one opened or reopened longest ago first; a warm one no one
    // has opened yet goes before any, thrown away, and one still being set up stays.
    const sleep = (id: () => number) => ({
      used: () => (open.has(id()) ? Math.max(open.get(id())!.opened, vms.alive().find((v) => v.id === id())?.used ?? 0) : ready.some((r) => r.id === id()) ? 0 : Infinity),
      async sleep() {
        const i = ready.findIndex((r) => r.id === id());
        if (i >= 0) return void (ready.splice(i, 1), await vms.drop(id()));
        if (!(await close(id()))) throw new Error(`VM #${id()} is still being set up`);
      },
    });

    // One deleted elsewhere (delete_vms, the daily check) is no longer open.
    taskEvents.on("event", (e) => void (e.type === "done" && open.delete(e.id)));

    function warmUp() {
      while (ready.length + warming < warmCount) {
        warming++;
        void (async () => {
          let held: { id: number; vm: Vm } | undefined;
          try {
            let id = 0;
            held = await vms.hold(`VM on ${warmRepo}`, { model: "code", sleep: sleep(() => id) });
            id = held.id;
            await prepareVm(held.vm, { repo: await bundle(ctx, warmRepo!), setup: warmSetup });
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

    async function openVm(request: { key: string; repo?: string; base?: string; setup?: string; where?: "local" | "cloud" }) {
      const fits = request.where ? (slot: number) => where(slot) === request.where : undefined;
      if (request.where === "cloud" && !endpoints.size) throw new Error("there's no cloud machine set up (the external-vm-node plugin)");
      if (!KEY.test(request.key.trim())) throw new Error("that isn't an ssh public key");
      const warm = request.repo && request.repo === warmRepo && !request.base && !request.setup && request.where !== "cloud" ? ready.shift() : undefined;
      if (warm) warmUp();
      const goal = `VM${request.repo ? ` on ${request.repo}` : ""}`;
      const repo = !warm && request.repo ? await bundle(ctx, request.repo, request.base) : undefined;
      let held = 0;
      const { id, vm } = warm ?? (await vms.hold(goal, { model: "code", fits, sleep: sleep(() => held) }));
      held = id;
      try {
        emit({ id, type: "queued", kind: "vm", goal, repo: request.repo });
        const hostKey = await prepareVm(vm, { key: request.key, repo, setup: warm ? undefined : request.setup }, (line) => emit({ id, type: "step", tool: "setup", text: line.slice(0, 300) }));
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
    // Closed: kept on disk to open again, or (`discard`) just stopped.
    async function close(id: number, discard = false) {
      if (!open.delete(id)) return false;
      await (discard ? vms.drop(id) : vms.give(id));
      return true;
    }

    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    appMethod("vms.open", async ({ key, repo, base, setup, where: at }, signal) => {
      if (typeof key !== "string") throw new Error("an ssh public key, please");
      const s = await openVm({ key, repo: str(repo), base: str(base), setup: str(setup), where: at === "local" || at === "cloud" ? at : undefined });
      // One whose asker went away before it was ready (an app sent to the background) is closed, so it's kept to
      // open again rather than left open with no one on it.
      if (signal.aborted) await close(s.id);
      return s;
    });
    appMethod("vms.reopen", async ({ sessionId, key }) => {
      const id = Number(sessionId);
      if (typeof key !== "string" || !KEY.test(key.trim())) throw new Error("an ssh public key, please");
      const already = open.get(id);
      const repo = already?.repo ?? vms.kept().find((k) => k.id === id)?.goal.match(/ on (.+)$/)?.[1];
      const vm = already ? undefined : await vms.reclaim(id, { model: "code", sleep: sleep(() => id) });
      if (!already && !vm) throw new Error(`no VM #${id} kept`);
      const hostKey = await prepareVm(vm ?? { slot: already!.slot, stop: async () => {} }, { key });
      const s = already ? { ...already, hostKey: hostKey ?? already.hostKey, opened: Date.now() } : await describe(id, vm!, repo, hostKey);
      open.set(id, s);
      if (!already) shown(s, "Reopened");
      return s;
    });
    appMethod("vms.close", async ({ sessionId, discard }) => {
      const id = Number(sessionId);
      const closed = await close(id, Boolean(discard));
      return { closed, discarded: discard ? closed || (await vms.forget(id)) : false };
    });
  },
} satisfies Plugin;
