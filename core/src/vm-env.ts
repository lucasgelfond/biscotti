import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { deployDaemon, detectPlatform, packagedDaemon, type SshTarget, sshArguments } from "@earendil-works/pi-env";

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
  const target = (id: number, at: { host: string; port: number }): SshTarget => ({
    host: at.host,
    port: at.port,
    user: "cua",
    identityFile: key,
    knownHostsFile: knownHosts,
    hostKeyAlias: `biscotti-vm-${id}`,
  });
  // The daemon's path in each VM, once deployed (and verified by its hash).
  const deployed = new Map<number, string>();

  return {
    publicKey: () => readFileSync(`${key}.pub`, "utf8").trim(),
    // The VM's host key, as its setup reported it ("ssh-ed25519 AAAA…"), trusted for its alias from now on.
    trust(id: number, hostKey: string) {
      const alias = `biscotti-vm-${id}`;
      const lines = existsSync(knownHosts) ? readFileSync(knownHosts, "utf8").split("\n").filter((l) => l && !l.startsWith(`${alias} `)) : [];
      writeFileSync(knownHosts, `${[...lines, `${alias} ${hostKey}`].join("\n")}\n`, { mode: 0o600 });
      deployed.delete(id);
    },
    forget(id: number) {
      deployed.delete(id);
    },
    // pi-env's daemon in VM `id` (reached at `at`) with `args` (its `serve --token <hex>`), piped to `socket` until
    // either side ends. It starts in the VM's login shell, for the PATH a shell there has.
    async pipe(id: number, at: { host: string; port: number }, args: string[], socket: Duplex) {
      if (!args.every((a) => /^[\w-]+$/.test(a))) throw new Error("bad pi-env arguments");
      const t = target(id, at);
      let file = deployed.get(id);
      if (!file) {
        const remote = await detectPlatform(t);
        file = await deployDaemon(t, remote, packagedDaemon(remote));
        deployed.set(id, file);
      }
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: pi-env\r\nConnection: Upgrade\r\n\r\n");
      const quoted = `'${file.replaceAll("'", "'\\''")}'`;
      const child = spawn("ssh", [...sshArguments(t), `exec "$SHELL" -lc 'exec "$0" "$@"' ${quoted}`, ...args], { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.on("data", (d) => console.error(`pi-env #${id}: ${String(d).trim()}`));
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      const end = () => {
        socket.destroy();
        child.kill();
      };
      child.on("exit", end);
      socket.on("close", end).on("error", end);
    },
  };
}
