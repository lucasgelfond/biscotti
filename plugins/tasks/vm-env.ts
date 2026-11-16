import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { acceptHostKey, deployDaemon, detectPlatform, forgetHostKey, packagedDaemon, type SshTarget, sshArguments } from "@earendil-works/pi-env";
import { taskEvents } from "./types.ts";

// pi-env into task VMs, for the agent, which holds no key and has no network: the gate's own SSH key (made once), each
// VM's host key as its setup reported it, and pi-env's daemon deployed to the VM and run over SSH, its framed protocol
// piped to the agent through the gate's socket. The agent's side (agent.ts) is a `Connection` whose command is that
// pipe (env-pipe.ts).

export function vmEnv(dir: string) {
  const ssh = `${dir}/ssh`;
  const key = `${ssh}/gate`;
  const knownHosts = `${ssh}/known_hosts`;
  mkdirSync(ssh, { recursive: true, mode: 0o700 });
  if (!existsSync(key)) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", "biscotti-gate", "-f", key]);
  const target = (id: number, at = { host: `biscotti-vm-${id}`, port: 22 }): SshTarget => ({
    host: at.host,
    port: at.port,
    user: "cua",
    identityFile: key,
    knownHostsFile: knownHosts,
    hostKeyAlias: `biscotti-vm-${id}`,
  });
  // A VM deleted for good is trusted no more (known_hosts keeps only the VMs still around).
  taskEvents.on("event", (e) => void (e.type === "done" && forgetHostKey(target(e.id)).catch(() => {})));
  // TODO: bake pi-env's daemon into the VM image, rather than sending it to each VM.
  // The daemon's path in each VM, once deployed (and verified by its hash).
  const deployed = new Map<number, string>();

  return {
    publicKey: () => readFileSync(`${key}.pub`, "utf8").trim(),
    // The VM's host key, as its setup reported it ("ssh-ed25519 AAAA…"), trusted for its alias from now on, in place
    // of the one it had (a VM set up again has a new one).
    async trust(id: number, hostKey: string) {
      const t = target(id);
      await forgetHostKey(t);
      await acceptHostKey(t, [`${t.hostKeyAlias} ${hostKey}`]);
      deployed.delete(id);
    },
    // pi-env's daemon in VM `id` (reached at `at`) with `args` (its `serve --token <hex>`), piped to `socket` until
    // either side ends. It starts in the VM's login shell, for the PATH a shell there has.
    async pipe(id: number, at: { host: string; port: number }, args: string[], socket: Duplex) {
      if (!args.every((a) => /^[\w-]+$/.test(a))) throw new Error("bad pi-env arguments");
      // The agent may hang up while the daemon is being sent: then nothing starts.
      let gone = false;
      socket.once("close", () => (gone = true));
      const t = target(id, at);
      let file = deployed.get(id);
      if (!file) {
        const remote = await detectPlatform(t);
        file = await deployDaemon(t, remote, packagedDaemon(remote));
        deployed.set(id, file);
      }
      if (gone || socket.destroyed) return;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: pi-env\r\nConnection: Upgrade\r\n\r\n");
      const quoted = `'${file.replaceAll("'", "'\\''")}'`;
      const child = spawn("ssh", [...sshArguments(t), `exec "$SHELL" -lc 'exec "$0" "$@"' ${quoted}`, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.on("data", (d) => console.error(`pi-env #${id}: ${String(d).trim()}`));
      // Either side ending ends the other: the agent's (its run is over) or ssh's (the VM went away).
      const end = () => {
        socket.destroy();
        child.kill();
      };
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", end);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      child.on("exit", (code, signal) => {
        if (code) console.error(`pi-env #${id}: ssh ended (${code ?? signal})`);
        end();
      });
      child.on("error", end);
      socket.on("close", end).on("error", end);
    },
  };
}
