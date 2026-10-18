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
│  Vaultwarden (logins, cards, PII)   SQLite (memories, transcripts)    │
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
| Models | **Vercel AI Gateway** (Pro plan), team-wide ZDR. Now: `anthropic/claude-opus-5.5`; planned switch to `deepseek/deepseek-v4.1-flash-1017` (reasoning model, ~1 s; **confirm it's ZDR-covered first**). No Fable (no ZDR). Key lives only in the host's `deploy/.env`; sandboxes reach the gateway through the bridge | pi provider config | decided |
| Local models | only the embedding model; chat and computer-use models stay on the AI Gateway | — | decided |
| Connectors | **One connector layer outside the sandbox** holds every token and tool; nothing connector-related enters a VM. **Now: Executor** (catalog apps, e.g. Google, GitHub, Airtable via its official MCP server; reached over MCP with an API key). **Reads pass; writes pause and the owner is texted** exactly what will happen; the main agent may `resume` only after the owner's own yes (one yes per request, enforced in code, `agent/src/connectors.ts`). Writes are ordinary tool calls for every agent, **confirmed by text for now** (revisit once we see how it feels). **Per-role permission table (P2)**, enforced on the host, never by the model: each tool is *allowed*, *delegated* (the task agent can't do it; it goes back to the main agent, which asks the owner) or *unavailable*. Main agent: reads allowed, writes after the owner's yes. Task VM: reads allowed, channel writes (email, messages) delegated, admin unavailable. The task agent's prompt lists what it can and can't do. Executor's approvals are held by the calling agent, so task VMs reach it only through a **thin pass-through in the agent process** on the bridge's `/tools`: reads go straight through, and a paused write is texted to the owner by the pass-through and resumed only on the owner's yes. A VM can request anything and approve nothing. **Later option:** our own thin layer in the agent process (gogcli `gog mcp` for Google, `gh`/GitHub's MCP server), enforcing approvals for every caller, if Executor (~490 MB, beta) fights us; Hermes and OpenClaw use such CLIs rather than a gateway | — | decided |
| Vault | **Vaultwarden**. The agent has its own account (`agent@biscotti.local`), **registered by the agent itself on first start** with a generated password (`agent/src/vault.ts`; no official tool registers accounts, so it follows the Bitwarden client's key setup, checked in E2E by logging in with Bitwarden's CLI). It reads items with **Bitwarden's official CLI** over HTTPS (Tailscale Serve), and sees **only items the owner shares** to it through an organization. `vault_list` gives names and which fields exist, never values; `vault_fill(item, field)` types a value into the desktop from the host. Logins fill without asking; **payment cards need the owner's yes**, enforced on the host. The owner views any secret in Vaultwarden itself | — | decided |
| Browser sessions | one Firefox profile per site account, encrypted with `age`, restored at sandbox start and saved back afterwards | — | decided |
| Memory | **SQLite** (one file in the agent's volume, Drizzle migrations). **One continuous conversation**, compacted by pi. `transcripts`: every pi session entry, kept after compaction; the session is rebuilt from it at startup; FTS5 over message text behind `search_transcript`. `memories`: facts saved with `remember`; `recall` fuses FTS5 bm25 and brute-force cosine over bge-small embeddings by reciprocal rank; `forget(id)`. Our own ~150 lines: the pi memory packages are per-project coding memory, and mem0 has telemetry on by default, OpenAI defaults and no pi integration (review: Hermes's capped MEMORY.md/USER.md snapshot and a pre-compaction save nudge are candidates for later) | — | decided |
| Embeddings | **On device: bge-small-en-v1.5** (MIT, ~33M, 384-dim) on the **llama.cpp server** (release binary in `deploy/llama`), model baked into the image at a pinned revision + SHA-256; nothing downloads or leaves the box. (EmbeddingGemma was rejected: Gemma license terms pass to every user.) | GGUF model ref | decided |
| Sandbox contents | **the task agent and the desktop in the same sandbox** (Instinct's layout) | — | decided |
| Bridge | **Caddy** adds the keys for Vercel and Executor; sandbox network access is limited to the bridge | — | decided |
| Sandbox runtime | **Firecracker** (bake-off winner; patched for GICv2 on the Pi 5: `lucasgelfond/firecracker@biscotti-gicv2`). **One fresh VM per task**, restored from a snapshot of the desktop taken once it is ready (`cua-vm/snapshots.sh`), and thrown away after. **Every task has a desktop**, so there is always a screen to send to the owner's phone. The disk is read-only and shared; each VM writes to a RAM overlay. The task agent is pi inside the VM (one `pi --mode json` run per connection on port 4000), reaching the model through the bridge's `/llm`. The main agent's `task(goal)` tool returns at once; the report comes back as a "Task report" message that the main agent summarizes. **One VM at a time** for now (the snapshot has one guest address); per-VM network namespaces would allow more | `agent/src/sandbox.ts` | decided |
| Web search | **Exa's hosted MCP server** (`https://mcp.exa.ai/mcp`; tools `web_search_exa` and `web_fetch_exa`, more via `?tools=`), for the main agent and for task agents. The key (`EXA_API_KEY`, sent as an `x-api-key` header) stays on the host: the main agent adds the header itself, and the bridge gets a `/search` route that adds it for VMs (as `/llm` adds the gateway key), with pi in the VM pointing its MCP config there. Setup reference: https://exa.ai/docs/get-started/exa-mcp | bridge route + VM `mcp.json` | **planned** |
| Desktop image | Cua's XFCE image, rebuilt multi-arch (`cua-vm/`) | — | decided |
| Network | **Tailscale**; `tailscale serve` on `biscotti.<tailnet>.ts.net` | — | decided |
| Control panel | **Svelte**, minimal | — | decided |
| Generated pages ("generative UI") | **Important spec.** The agent can make web pages (comparison tables, itineraries, dashboards, forms to fill in) and send a link. Pages are static files the agent writes, served on the tailnet by the existing Caddy / `tailscale serve` (e.g. `https://biscotti.<tailnet>.ts.net/p/<id>`). Interactive pages post back to the agent through the same host. No public hosting | publish location | decided |
| Attachments over text | **Important spec.** Send and receive files (images, PDFs, screenshots from the sandbox, generated docs) through Photon's attachment support. Received files are saved for the agent; large outputs go out as a generated-page link | `bot/` | decided |
| Approvals | sending any email/message, purchases, deletes, account/settings changes, website form submissions. Captchas and 2FA go to the user by text. Lives in the system prompt. | — | decided |

## Deployment targets

The same `deploy/compose.yaml` runs everywhere. Each target only decides how the
host gets set up and which sandbox runtime it can use.

| Target | How the host gets set up | Sandbox runtimes |
|---|---|---|
| **Raspberry Pi 5** (first) | flashable image | docker, gvisor (Ubuntu kernel), firecracker / microsandbox (KVM, to be tested) |
| Generic Linux / Hetzner dedicated | install script on Ubuntu | all |
| Mac (M3+) | Lima VM with nested virtualization (`deploy/mac/lima.yaml`) | **firecracker (stock, GICv3)**, docker, gvisor |
| ~~Hetzner Cloud (CX…)~~ | not supported: no KVM | — |

**biscotti requires KVM** (decided 2026-10-17): Pi 5, Mac M3+ (via Lima nested virtualization), Hetzner
dedicated or any Linux box with KVM. No gVisor fallback and no cloud VPS without KVM; the sandbox interface stays
small enough to add one later if that changes.

**Host OS: NixOS** (`flake.nix`, `deploy/nixos/`): one shared module (`biscotti.nix`), small per-target files
(`pi5.nix` via nvmd/nixos-raspberrypi, `vm.nix` for local testing; Lima and server targets to come). Nothing personal
in the image: SSH keys and Wi-Fi come from the boot partition (Wi-Fi country too: open item).

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
4. The control panel, which only works over Tailscale, is the **one front door** but stays **thin**: Executor's
   UI is where connectors, accounts and tool policies are managed, and Vaultwarden's is where secrets are added
   and viewed. The panel is a setup checklist, status, and links into both. It walks through the setup steps:
   1. Tailscale ✓
   2. Photon: paste the project ID and secret
   3. Vercel AI Gateway key, plus a ZDR reminder
   4. Executor: links into Executor's own UI to add Google and other connectors
   5. Vaultwarden: create the account and add items
   6. Environment variables / per-service settings (edits one `.env`, then restarts services)

Security note: the login-URL QR code lets whoever scans it first add the Pi to
their tailnet. That's acceptable for a device in your hands. The URL is
short-lived, and no secrets ever go in query parameters.

### Installer (later, after the core works)

The goal is a **small native macOS app (Swift)** that does the whole card setup, so nobody edits boot files. It should
look and feel like Raspberry Pi Imager and stay tiny (**about 5 Swift files at most**):
1. Lists removable devices and detects an inserted SD card.
2. Flashes the biscotti image for the chosen target. **Pi 5 only** for now; other targets later.
3. With one click, writes the installer's **Wi-Fi** (the Mac's current network, its password from the keychain
   with the user's permission, and the Wi-Fi **country**) and their **SSH public key** (`~/.ssh/*.pub`) onto the
   card's boot partition. The NixOS image reads `wpa_supplicant.conf` and `authorized_keys` from there, so the
   image itself stays generic.
4. **Owner pairing:** asks for the owner's phone number (or iMessage email) and writes it to the boot partition, so
   the agent answers only them from the first text.
5. Optionally a Tailscale auth key, so the device joins the tailnet on first boot.

Until it exists: Raspberry Pi Imager to flash, then copy those boot-partition files by hand (see `deploy/pi/README.md`).
Every installer must get their own SSH key and Wi-Fi in; nothing personal is baked into the image.

## Repo layout (planned)

```
biscotti/
  DESIGN.md        this file
  agent/           the bot: Photon Spectrum → pi, system prompt, tools (memory; sandbox, vault_fill next); Node + pnpm
  tests/           end-to-end tests and their fakes
  panel/           Svelte control panel
  site/index.html  public onboarding page (biscotti.lucasgelfond.online)
  cua-vm/          desktop image build toolchain only (Dockerfile fork, rootfs/VM-disk build)
  development/     bake-off scripts + results (patched Firecracker: lucasgelfond/firecracker@biscotti-gicv2)
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
3. **Platform services** in `deploy/compose.yaml`: embeddings, Executor (pinned), Vaultwarden, Caddy bridge, tailscale serve. *Check:* each UI is reachable on ts.net.
4. **Main agent + bot.** pi with Vercel and ZDR, Photon echo → pi, system prompt including the approval policy. *Check:* text it, get an answer.
5. **Task sandbox.** The spawn tool, task pi inside the sandbox via the bridge, browser profile restore/save, `vault_fill`. *Check:* "log into X and tell me Y".
6. **Memory.** `remember` / `recall` / `search_transcript` on SQLite. *Check:* recalls a fact across conversations.
6a. **Testing approach:** features are tested **end to end only**, through the real agent; no unit tests for our
   glue code. Tests live in `tests/` (not next to the code). Exception: upstream patches follow the upstream
   project's convention (e.g. Firecracker's in-file unit tests).
6b. **E2E harness** in `tests/` (built alongside steps 4–6):
   - **Fakes:** a local text channel instead of Photon; a mock approver
     (approve / deny / timeout); a fake Google MCP server registered in Executor
     and backed by fixture inbox and calendar data; Vaultwarden seeded with fake
     items; public practice sites plus local fixture sites.
   - **Real:** the agent, its tools, SQLite, the on-device embeddings, and the model via the AI Gateway
     (production's by default; `MODEL=` picks another).
   - **Assertions:** pi's tool-call log, the sandbox's final URL/DOM/screenshot,
     fake-server state, and grounding (every quoted number appears in a source).
   - Covers the v1 smoke suite in `docs/should-be-supported-tasks.md`.
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
- Base OS for the image: not tied to Ubuntu. Candidates: NixOS (one declarative
  config for Pi + x86/Hetzner images), Raspberry Pi OS via rpi-image-gen, Arch
  Linux ARM, Alpine, DietPi. Constraint: gVisor needs a 48-bit-VA kernel
  (Raspberry Pi OS's is 39-bit); Firecracker and runc don't care.
- Where `site/` is hosted (Cloudflare Pages / GitHub Pages).
- A headless Pi (no HDMI): is the hotspot page the only place the QR shows?
- Confirm Imager's customisation writes cloud-init for our Ubuntu-based image
  (Imager supports `init_format: cloudinit` in repository JSON).
- Owner pairing is the installer's job (above). Until then `OWNER` is set by hand from the sender ID the
  agent logs.

- Backlog (ideas from comparing with Instinct):
  - **Wakes:** scheduled prompts ("remind me at 5") and event subscriptions (new mail matching X, calendar
    changes), so the agent can act without being texted first.
  - **`vault_request`:** a one-time web form for a secret the agent needs, so secrets never travel over iMessage.
  - **Derived fill fields:** `totp` (fill the current 2FA code) and card expiry as MM/YY; fill into digit boxes and
    `<select>`s.
  - **Task screenshots as attachments** that travel with the task report to the owner's phone.
  - Per-site browsing notes the agent records and reuses; email sender-authenticity (SPF/DKIM/DMARC) shown with
    untrusted content.
- From the Open Instinct review (`docs/lit-review/open-instinct.md`):
  - Hash-bind approvals to the exact call (tool + args, TTL, single use, owner 1:1 thread only).
  - Filter which tools agents can see, in addition to gating calls.
  - Trust tiers for non-owners; `<untrusted>` wrapping.
  - An owner-readable audit log; single-use cards instead of stored cards; a live-desktop takeover view.

## Field notes

- The Pi 5 joins 5 GHz on a DFS channel (52) fine: ~5 MB/s versus ~0.15–0.7 MB/s
  on congested 2.4 GHz. The original failure was an SSID typo ("5G" vs "-5G").
  But on a cold boot the Wi-Fi regulatory domain is "world" (00), and the Pi can't
  join a DFS channel until an AP's country IE sets it to US. Configuring only the
  5 GHz DFS network leaves a fresh Pi offline. Always keep a 2.4 GHz (or non-DFS)
  fallback; once online, move to 5 GHz. Product image: set the regulatory domain
  before Wi-Fi comes up (open question). Imager copying the exact SSID avoids typos.
- Unattended-upgrades runs on first boot and competes for bandwidth.
- Preparing a Pi SD card: follow the one-trip checklist in `deploy/pi/README.md` (cold-boot Wi-Fi, exact SSIDs,
  cloud-init `instance_id`, a diagnostics dump to `/boot/firmware/`).
