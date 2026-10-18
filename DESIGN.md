# biscotti

Biscotti: a lightweight, Instinct-like agent harness. A personal agent you text over iMessage, running on hardware you
own. Diagram: [docs/architecture.html](docs/architecture.html) (PNGs next to it).

## Principles

1. **A small core, features as plugins.** The core is what everything needs: the agent, memory, the gate and task VMs
   (~650 lines). Everything else is a plugin that `biscotti.json` turns on.
2. **Off-the-shelf first.** pi for agents, Photon for iMessage, Firecracker for VMs, Tailscale for access, NixOS for the
   host, SQLite for state.
3. **The gate holds every key.** The main agent and task VMs reach the model and every tool only through it, and it asks
   the owner before anything that needs a yes.
4. **Tested end to end only**, through the real agent and model (`tests/`).
5. **Dependencies at least a week old.**

## Layout

```
core/            agent, memory, gate, task VMs, plugin API (src/); VM image (vm/); compose for the agent (host/)
plugins/         channels/spectrum, connectors/executor, exa, wakes, artifacts, embedding, secrets/sqlite
installers/      toolchain (NixOS modules + Pi image), setup-app (macOS card writer), local (Lima on a Mac)
tests/           end-to-end tests; compose.yaml for their services
biscotti.json    which plugins load
```

## Core

- **Agent:** pi SDK, one long conversation rebuilt from the `transcripts` table and compacted by pi. A message that
  arrives mid-reply steers it. Tools: memory, `react` (tapback), `task`, plus every plugin tool through the gate's MCP.
- **Memory:** SQLite (Drizzle migrations). `remember` / `recall` / `forget` over `memories`, `search_transcript` over
  every message. FTS5 keyword search, with Recall plugins (embeddings) fused in by reciprocal rank.
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
| wakes | prompts the agent schedules for itself (cron or once); `croner` |
| artifacts | HTML pages texted as links; public over Funnel under unguessable names so iMessage shows a preview card |
| embedding | bge-small on llama.cpp, on device; recall by meaning |
| secrets/sqlite | logins and cards, AES-256-GCM in SQLite; entered through one-time forms on the tailnet; "ask me" secrets need a yes per use |
| connectors/executor | Google and GitHub through Executor; paused calls resume with the owner's answer |

## Host

NixOS (`flake.nix`, `installers/toolchain/`): `net.nix` (the VM slots and firewall), `setup.nix` (first boot: settings
from the installer, generated secrets, Tailscale with a texted login link, the services for the enabled plugins, the
snapshot, a "ready" text). The Pi image reads Wi-Fi and SSH keys from the boot partition; nothing personal is baked in.
State lives in `/var/lib/biscotti` (`.env`, `biscotti.json`, `data/`, `vm/`).

## Connectors: replacing Executor (recommendation)

From a sweep of pi, OpenClaw/mcporter and Hermes: a ~300-line `connectors/mcp` plugin on the MCP SDK we already use.
- Config: a list of MCP servers (`{url, headers}`, `{url, oauth}`, or `{command, args}`).
- OAuth with our own SDK `OAuthClientProvider`, tokens in the secrets store; the sign-in link is texted, the callback
  lands on the tailnet. Google needs `access_type=offline` added for refresh tokens.
- Approvals in the gate from MCP hints (`destructiveHint`, or not `readOnlyHint`), with per-tool overrides.
- Google: `gog mcp` (stdio, has hints; Calendar and Drive are read-only, so add a few small tools) or Google's
  Workspace MCP endpoints (developer preview). GitHub: `api.githubcopilot.com/mcp/` with a fine-grained PAT.
- We'd lose Executor's UI, catalog and multi-account routing; we'd drop a 659 MB beta container.

## To-dos

- New card: build the NixOS image, flash it with the setup app, first boot end to end; boot the `vm` config in Lima
  first to check `net.nix` and `setup.nix`.
- Setup app: plugin checkboxes that write `biscotti.json` to the boot partition.
- `installers/local`: Lima on a Mac with nested KVM (stock Firecracker works there, GICv3).
- Connectors plugin (above), event wakes, a per-role permission table, a pre-compaction memory nudge.
- Encrypt the whole database at rest (SQLCipher) if backups leave the box.

## Field notes

- The Pi 5 can't join a DFS 5 GHz channel on a cold boot (regulatory domain "world"); keep a 2.4 GHz network, or set
  the domain before Wi-Fi starts (`pi5.nix` does).
- Restored VMs get the host's time from chrony on KVM's PTP clock within ~2 s.
- Firefox in the VM renders black with user namespaces on; the VM init turns them off.
- The first task after boot is slow (~15 s) when the snapshot's memory isn't in the page cache; the agent reads it in at
  start.
