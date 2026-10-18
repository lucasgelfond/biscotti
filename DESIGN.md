# biscotti

Biscotti: a lightweight, Instinct-like agent harness. A personal agent you text over iMessage, running on hardware you
own. Diagram: [docs/architecture.html](docs/architecture.html) (PNGs next to it).

## Principles

1. **A small core, features as plugins.** The core is what everything needs: the agent, an encrypted store (memory,
   crons, vault), the gate and task VMs. Everything else is a plugin that `biscotti.json` turns on.
2. **Off-the-shelf first.** pi for agents, Photon for iMessage, Firecracker for VMs, Tailscale for access, NixOS for the
   host, SQLite for state.
3. **The gate holds every key.** The main agent and task VMs reach the model and every tool only through it, and it asks
   the owner before anything that needs a yes.
4. **Tested end to end only**, through the real agent and model (`tests/`).
5. **Dependencies at least a week old.**

## Layout

```
core/            agent, memory, crons, vault, gate, task VMs, plugin API (src/); VM image (vm/); compose (host/)
plugins/         channels/spectrum, exa, google, github, artifacts, embedding, executor
installers/      toolchain (NixOS modules + Pi image), setup-app (macOS card writer), local (Lima on a Mac)
tests/           end-to-end tests; compose.yaml for their services
biscotti.json    which plugins load
```

## Core

- **Agent:** pi SDK, one long conversation rebuilt from the `transcripts` table and compacted by pi. A message that
  arrives mid-reply steers it. Tools: memory, `react` (tapback), `task`, plus every plugin tool through the gate's MCP.
- **Store:** one SQLite file encrypted at rest (SQLite3 Multiple Ciphers, `DB_KEY` generated on first boot; an older
  plaintext database is encrypted in place).
- **Memory:** `remember` / `recall` / `forget` over `memories`, `search_transcript` over
  every message. FTS5 keyword search, with Recall plugins (embeddings) fused in by reciprocal rank.
- **Crons:** prompts the agent schedules for itself (cron or once, `croner`); when due they come back as a message.
- **Vault:** logins, cards and licenses, entered through one-time forms on the tailnet, never in chat; ones marked
  "ask me" need the owner's yes per use.
- **Gate:** `/llm` maps model names (`main`, `task`) to AI Gateway ids and adds the key; `/mcp` serves every plugin's
  tools; `ask()` texts the owner a yes-or-no question (one at a time, one yes per request, 10-minute timeout).
- **Task VMs:** Firecracker (patched for the Pi 5's GICv2: `lucasgelfond/firecracker@biscotti-gicv2`). A fresh VM per
  task, restored from a snapshot of a ready desktop in ~40 ms, in one of three slots (network namespaces where every VM
  looks the same). One VM is always restored ahead of time, and pi waits inside the snapshot in RPC mode, so a short
  task finishes in ~3 s. VMs reach the internet and the gate only. The report and a final screenshot come back as a
  message; the owner can watch or take over a live desktop over Tailscale.

## Plugins

A plugin is `plugins/<name>/index.ts` default-exporting `{ prompt?, channel?, tools?, recall?, start? }`
(`core/src/plugin.ts`). One with a service of its own ships a `compose.yaml`.

| Plugin | What it does |
|---|---|
| channels/spectrum | iMessage through Photon; only the owner's texts come through |
| exa | web search and fetch (Exa's hosted MCP) |
| google | Gmail and Calendar over Google's REST APIs with the owner's OAuth client (sign-in link texted; offline refresh token in the store); sending and calendar changes ask first |
| github | GitHub's remote MCP server with a fine-grained token; anything not marked read-only asks first |
| artifacts | HTML pages texted as links; public over Funnel under unguessable names so iMessage shows a preview card |
| embedding | bge-small on llama.cpp, on device; recall by meaning |
| executor | optional: Executor's catalog of apps over MCP, with its paused calls approved by text (off by default; a 659 MB container) |

## Host

NixOS (`flake.nix`, `installers/toolchain/`): `net.nix` (the VM slots and firewall), `setup.nix` (first boot: settings
from the installer, generated secrets, Tailscale with a texted login link, the services for the enabled plugins, the
snapshot, a "ready" text). The Pi image reads Wi-Fi and SSH keys from the boot partition; nothing personal is baked in.
State lives in `/var/lib/biscotti` (`.env`, `biscotti.json`, `data/`, `vm/`).

## Connectors

Executor is an optional plugin, off by default (a 659 MB beta container with its own UI). From a sweep of pi, OpenClaw/mcporter and Hermes, the
lightweight path: small plugins per service, approvals in the plugin through the gate's `ask`. Google is our own REST
tools (~200 lines); GitHub is its official remote MCP server (~30 lines). More services: a remote MCP server with a
token, or a few REST tools.

## Cloud (no Pi)

Task VMs need KVM, so the host must be bare metal or a VM with nested virtualization:
- **Works:** AWS C8i/M8i/R8i (nested virtualization on virtual instances since Feb 2026, later C7i/M7i/R7i too;
  m8i.large is ~$0.14/h), GCP (N2 and others, with the nested-virtualization flag), Azure (Dv5/Ev5 and AMD v6), Hetzner
  dedicated and auction servers (~€40/mo). DigitalOcean exposes nested KVM but calls it unsupported.
- **Doesn't:** Hetzner Cloud, Linode, Fly.io, Railway (no `/dev/kvm`).
- **Plan:** an `x86_64` NixOS target (no GICv2 patch needed there), built as a cloud image, plus a one-command
  installer per provider. A no-KVM fallback would run the desktop in a container (gVisor/runc) instead of Firecracker:
  slower and no snapshots, but any VPS.

## To-dos

- New card: build the NixOS image, flash it with the setup app, first boot end to end; boot the `vm` config in Lima
  first to check `net.nix` and `setup.nix`.
- Setup app: plugin checkboxes that write `biscotti.json` to the boot partition.
- `installers/local`: Lima on a Mac with nested KVM (stock Firecracker works there, GICv3).
- Google sign-in: add `https://<TAILNET_HOST>:9443/oauth/callback` to the OAuth client's redirect URIs.
- Cloud target (above), event wakes, a per-role permission table, a pre-compaction memory nudge.

## Field notes

- The Pi 5 can't join a DFS 5 GHz channel on a cold boot (regulatory domain "world"); keep a 2.4 GHz network, or set
  the domain before Wi-Fi starts (`pi5.nix` does).
- Restored VMs get the host's time from chrony on KVM's PTP clock within ~2 s.
- Firefox in the VM renders black with user namespaces on; the VM init turns them off.
- The first task after boot is slow (~15 s) when the snapshot's memory isn't in the page cache; the agent reads it in at
  start.
