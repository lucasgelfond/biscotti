import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Tests nix/apps-check.jq against `docker compose config --format json` output.

const dir = "/var/lib/biscotti-apps/mail";
const check = fileURLToPath(new URL("../nix/apps-check.jq", import.meta.url));
const problems = (config: object) =>
  execFileSync("jq", ["-r", "--arg", "dir", dir, "-f", check], { input: JSON.stringify(config) }).toString().split("\n").filter(Boolean);
const service = (fields: object) => ({ services: { mail: { image: "mail", ...fields } } });

test("passes an app with a Tailscale sidecar, its own files and volumes", () => {
  const config = {
    services: {
      tailscale: {
        image: "tailscale/tailscale",
        cap_add: ["NET_ADMIN"],
        devices: [{ source: "/dev/net/tun", target: "/dev/net/tun", permissions: "rwm" }],
        volumes: [{ type: "bind", source: `${dir}/tailscale`, target: "/var/lib/tailscale" }],
        env_file: [{ path: `${dir}/.env` }],
      },
      mail: {
        image: "mail",
        network_mode: "service:tailscale",
        volumes: [{ type: "volume", source: "maildata", target: "/data" }],
        build: { context: `${dir}/mail` },
      },
    },
    volumes: { maildata: { name: "app-mail_maildata" } },
    secrets: { dkim: { name: "app-mail_dkim", file: `${dir}/dkim.key` } },
  };

  const found = problems(config);

  expect(found).toEqual([]);
});

test.for([
  ["privileged", service({ privileged: true }), "mail: privileged"],
  ["the host's network", service({ network_mode: "host" }), "mail: network_mode host"],
  ["another container's network", service({ network_mode: "container:biscotti-gate-1" }), "mail: network_mode container:biscotti-gate-1"],
  ["the host's processes", service({ pid: "host" }), "mail: pid host"],
  ["biscotti's settings", service({ volumes: [{ type: "bind", source: "/var/lib/biscotti/.env", target: "/x" }] }), "mail: mounts /var/lib/biscotti/.env"],
  ["a neighbor's directory", service({ volumes: [{ type: "bind", source: `${dir}-old/data`, target: "/x" }] }), `mail: mounts ${dir}-old/data`],
  ["the Docker socket", service({ volumes: [{ type: "bind", source: "/run/docker.sock", target: "/run/docker.sock" }] }), "mail: mounts /run/docker.sock"],
  ["another container's volumes", service({ volumes_from: ["container:biscotti-gate-1"] }), "mail: volumes_from container:biscotti-gate-1"],
  ["biscotti's settings as env", service({ env_file: [{ path: "/var/lib/biscotti/.env" }] }), "mail: env_file /var/lib/biscotti/.env"],
  ["a build from the root", service({ build: { context: "/" } }), "mail: builds from /"],
  ["a device", service({ devices: [{ source: "/dev/kvm", target: "/dev/kvm", permissions: "rwm" }] }), "mail: device /dev/kvm"],
  ["an external volume", { ...service({}), volumes: { gate: { name: "biscotti_data", external: true } } }, "volumes: gate is external"],
  ["an external network", { ...service({}), networks: { gate: { name: "biscotti_default", external: true } } }, "networks: gate is external"],
  ["a volume bound to a host path", { ...service({}), volumes: { data: { driver_opts: { type: "none", o: "bind", device: "/var/lib/biscotti" } } } }, "volumes: binds /var/lib/biscotti"],
  ["a secret from biscotti's settings", { ...service({}), secrets: { key: { file: "/var/lib/biscotti/.env" } } }, "secrets: reads /var/lib/biscotti/.env"],
] as const)("stops an app that reaches for %s", ([, config, problem]) => {
  const found = problems(config);

  expect(found).toEqual([problem]);
});
