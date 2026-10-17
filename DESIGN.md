# biscotti — design decisions & plan

A self-hosted personal assistant you text. It handles your accounts, can use a
real desktop, and keeps your credentials on hardware you own. The design follows
Instinct's split between a durable platform and disposable sandboxes, built the
way pi is built: combine a few good off-the-shelf parts and write very little
code of our own.

## Principles

1. **Off-the-shelf first.** Our code is glue: config, a system prompt, a few pi
   extensions, a small control panel, and image build recipes.
2. **Thin, swappable layers.** Each layer has one provider now. A single
   interface sits wherever a swap is likely (sandbox runtime, deploy target).
   No speculative abstraction anywhere else.
3. **No architecture-specific code.** Images are multi-arch (arm64 + amd64).
   Runtime and target are chosen by config, not by code branches.
4. **The Pi is one deployment target among several.** The same compose stack
   runs on a Pi, a Mac mini or a Hetzner box.
5. **Secrets never enter the sandbox or the model context.** The model sees
   references; values are injected at the boundary.
6. **Tailscale-only.** No public ports. The only public piece is a static
   instructions page.

## Architecture

```
            iMessage (Photon cloud, outbound stream; no inbound ports)
                                  │
┌──────────────── Platform (durable, on the host) ──────────────────────┐
│  bot ─► main agent (pi): system prompt, policy, approvals             │
│            │ spawn task(type, scopes)                                 │
│            ▼                                                          │
│  sandbox provider ── docker | gvisor | firecracker | microsandbox     │
│                                                                       │
│  Executor (connectors, per-tool allow/approve/block, multi-account)   │
│  Vaultwarden (logins, cards, PII)   Postgres+pgvector (memory)        │
│  Caddy bridge (adds keys to requests; the only host the sandbox sees) │
│  control panel (Svelte)             tailscale serve (HTTPS on ts.net) │
└───────────────────────────────────────────────────────────────────────┘
          ▲ bridge only
┌──── Sandbox (disposable, one per task) ────┐
│ task agent (pi) + bash/python              │
│ Xvfb + XFCE + Firefox + cua-spacesd        │
│ restored browser profile for the task      │
└────────────────────────────────────────────┘
```

## Layers and decisions

| Layer | Choice | Swap point | Status |
|---|---|---|---|
| Harness | **pi** (main agent + task agents) | — | decided |
| Messaging | **Photon Spectrum**, cloud iMessage, shared line | `bot/` is the only code that touches it | decided |
| Models | **Vercel AI Gateway** (Pro plan), team-wide ZDR, Opus 5.5 for the main agent / Sonnet 5.5 for tasks, no Fable (no ZDR) | pi provider config | decided |
| Local models | none for now | — | decided |
| Connectors | **Executor**, self-hosted, `elicitation_mode=browser`; reads allowed, writes need approval, admin blocked; one connection per Gmail account; only the Google access you're comfortable with | pi MCP config | decided |
| Vault | **Vaultwarden**, plus one `vault_fill(item, field)` tool that types values into the desktop without returning them to the model | the `vault_fill` implementation | decided |
| Browser sessions | one Firefox profile per site account, encrypted with `age`, restored at sandbox start and saved back afterwards | — | decided |
| Memory | **Postgres + pgvector**, a single `observations` table plus full-text search; `remember` / `recall` tools; no bulk indexing in v1 | — | decided |
| Embeddings | via the AI Gateway (no local models) | — | decided |
| Sandbox contents | **the task agent and the desktop in the same sandbox** (Instinct's layout) | — | decided |
| Bridge | **Caddy** adds the keys for Vercel and Executor; sandbox network access is limited to the bridge | — | decided |
| Sandbox runtime | to be chosen by the bake-off (below) | `SandboxProvider`: create / exec / screenshot / snapshot / destroy | **open** |
| Desktop image | Cua's XFCE image, rebuilt multi-arch (`cua-vm/`) | — | decided |
| Network | **Tailscale**; `tailscale serve` on `biscotti.<tailnet>.ts.net` | — | decided |
| Control panel | **Svelte**, minimal | — | decided |
| Approvals | sending any email/message, purchases, deletes, account/settings changes, website form submissions. Captchas and 2FA go to the user by text. Lives in the system prompt. | — | decided |

## Deployment targets

The same `deploy/compose.yaml` runs everywhere. Each target only decides how the
host gets set up and which sandbox runtime it can use.

| Target | How the host gets set up | Sandbox runtimes |
|---|---|---|
| **Raspberry Pi 5** (first) | flashable image | docker, gvisor (Ubuntu kernel), firecracker / microsandbox (KVM, to be tested) |
| Generic Linux / Hetzner dedicated | install script on Ubuntu | all |
| Mac mini | Docker via OrbStack/colima | docker only (no KVM in the Linux VM); a remote sandbox provider later |
| Hetzner Cloud (CX…) | install script | docker, gvisor (no KVM) |

## First-boot / onboarding flow (for the Pi image)

0. **Boot splash:** "Biscotti" with an SVG biscotti, and the boot/setup log lines
   scrolling underneath. Likely a Plymouth theme; the splash itself is a design
   asset, not code.
1. **Wi-Fi comes from the computer that flashes the card, with nothing typed and
   nothing baked into the image.** Ship biscotti as a custom OS entry for
   **Raspberry Pi Imager** (a repository JSON passed with `--repo`, or "Use
   custom"). Imager already pre-fills the computer's current Wi-Fi network and
   password and writes them, plus hostname and SSH settings, into the card's
   cloud-init. No flasher app of our own; we only publish the image and the JSON.
   - Rejected: Wi-Fi over Bluetooth via QR code (iOS Safari has no Web
     Bluetooth, and it needs a provisioning daemon).
   - Fallback with no flashing computer: a setup hotspot (comitup). Later.
   - Later: once online, the Pi could suggest a better network.
2. Once online, it runs `tailscale up` and shows a **QR code on HDMI** (and on
   the hotspot page as a fallback).
   - The Pi doesn't know a tailnet until someone logs in, so there are two QR
     codes, one for each state:
     - **Not joined:** `https://biscotti.lucasgelfond.online/?login=<tailscale login URL>`
     - **Joined:** `https://biscotti.lucasgelfond.online/?tailnet=<tailnet>&host=biscotti`
3. `biscotti.lucasgelfond.online` is **one static HTML file** (public hosting,
   no backend). It reads the query parameters and shows:
   - install Tailscale (App Store / Play / desktop links)
   - "Authorize this Pi": the login link, so nothing has to be typed
   - "Open your control panel": `https://biscotti.<tailnet>.ts.net`
4. The control panel, which only works over Tailscale, walks through the setup steps:
   1. Tailscale ✓
   2. Photon: paste the project ID and secret
   3. Vercel AI Gateway key, plus a ZDR reminder
   4. Executor: links into Executor's own UI to add Google and other connectors
   5. Vaultwarden: create the account and add items
   6. Environment variables / per-service settings (edits one `.env`, then restarts services)

Security note: the login-URL QR code lets whoever scans it first add the Pi to
their tailnet. That's acceptable for a device in your hands. The URL is
short-lived, and no secrets ever go in query parameters.

## Repo layout (planned)

```
biscotti/
  DESIGN.md        this file
  agent/           pi config, system prompt, extensions (sandbox, memory, vault_fill)
  bot/             Photon Spectrum entrypoint (bun)
  panel/           Svelte control panel
  site/index.html  public onboarding page (biscotti.lucasgelfond.online)
  cua-vm/          desktop image build toolchain only (Dockerfile fork, rootfs/VM-disk build)
  bench/           sandbox runtime bake-off scripts + results
  deploy/          compose.yaml, Caddyfile, install.sh, pi-image/ recipe
```

## Plan

Each step ends with something you can check.

0. **Pi bootstrap.** Ubuntu Server 24.04.5 on the 64 GB card, cloud-init with an SSH key and Tailscale. *Check:* `ssh lucas@biscotti`.
1. **`cua-vm/`.** Multi-arch build of Cua's XFCE image (swap the KiCad base for `debian:bookworm`), plus a Firecracker rootfs and guest kernel. *Check:* desktop reachable over VNC on the Pi.
2. **Bake-off** in `bench/`: docker → gvisor → firecracker (raw) → microsandbox. Measures:
   - launch → desktop ready
   - snapshot restore
   - idle and browsing RAM
   - page load
   - screenshot → action latency
   - pi inside the sandbox working
   
   SD-card numbers are flagged. *Check:* results table, then pick the runtime here.
3. **Platform services** in `deploy/compose.yaml`: Postgres, Executor (pinned), Vaultwarden, Caddy bridge, tailscale serve. *Check:* each UI is reachable on ts.net.
4. **Main agent + bot.** pi with Vercel and ZDR, Photon echo → pi, system prompt including the approval policy. *Check:* text it, get an answer.
5. **Task sandbox.** The spawn tool, task pi inside the sandbox via the bridge, browser profile restore/save, `vault_fill`. *Check:* "log into X and tell me Y".
6. **Memory.** `remember` / `recall` on pgvector. *Check:* recalls a fact across conversations.
7. **Control panel** (Svelte) with the setup checklist and env editor.
8. **Onboarding site** `site/index.html` + first-boot QR service.
9. **Pi image build**, only after steps 1–8 work. *Check:* you flash it on a fresh card and onboard from scratch.
10. **Other targets:** run `install.sh` on a non-Pi box to prove portability.

## Needs from you

- Wi-Fi name/password for the Pi, or Ethernet; optionally a Tailscale auth key
- Vercel Pro + AI Gateway key, with team ZDR turned on
- Photon project secret (scaffold: `bun create spectrum-project@latest biscotti --projectId d737c377-d337-43cc-94b9-9f08c3c162da --providers imessage --yes`)
- A Google Cloud OAuth client published to Production (for Executor)
- DNS for `biscotti.lucasgelfond.online` → static hosting (step 8)
- Later: an NVMe drive (256–512 GB) for realistic snapshot numbers

## Open questions

- Sandbox runtime (decided by the bake-off).
- Base OS of the Pi image: Ubuntu (needed if gVisor wins) vs Raspberry Pi OS (rpi-image-gen).
- Where `site/` is hosted (Cloudflare Pages / GitHub Pages).
- A headless Pi (no HDMI): is the hotspot page the only place the QR shows?
- Confirm Imager's customisation writes cloud-init for our Ubuntu-based image
  (Imager supports `init_format: cloudinit` in repository JSON).

## Field notes

- The Pi 5 joins 5 GHz on a DFS channel (52) fine: ~5 MB/s versus ~0.15–0.7 MB/s
  on congested 2.4 GHz. The original failure was an SSID typo ("5G" vs "-5G").
  With both bands configured, wpa_supplicant sticks to whichever it joined first,
  so configure only the 5 GHz network. Imager copying the exact SSID avoids typos.
- Unattended-upgrades runs on first boot and competes for bandwidth.
