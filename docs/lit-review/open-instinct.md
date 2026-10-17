# Open Instinct on Maritime: architecture review

Sources: https://maritime.sh/blog/open-instinct-personal-agent-on-maritime ·
https://github.com/mariagorskikh/open-instinct (MIT, TypeScript, v0.1 beta, created 2026-10-03), including
`docs/ARCHITECTURE.md`, `docs/SECURITY.md` and `docs/DEPLOY-MARITIME.md` · maritime.sh pricing and blog. Maritime
itself is a closed hosted service. Reviewed 2026-10-17.

## Their architecture
- **Messaging:** Inkbox (SaaS) gives each agent a phone number, iMessage, email and an A2A endpoint. It sends HMAC-signed
  webhooks to a stateless gateway, which wakes the VM through Maritime `/chat`.
- **Harness:** pi (`pi-agent-core`, `pi-coding-agent`, `pi-mcp`): one agent and one JSONL session per conversation key;
  in groups, each participant gets a separate transcript.
- **Runtime:** one **persistent** Firecracker VM per user on Maritime. `desktop: true` adds Chromium plus `desktopd`
  (4 GiB / 2 vCPU). State lives in flat files under `/data`. The VM is snapshotted after 15 min idle; claimed wake
  times range from 0.6 s to 3 s across their own docs.
- **No sandbox between agent and desktop:** `bash` is a real shell, and logins persist in the VM's browser profile.
- **Credentials:**
  - API keys are encrypted env vars. Shell tools remove env vars named like secrets.
  - Logins, 2FA and captchas use `request_takeover`: the owner gets a live-desktop link and types the secret.
  - App OAuth goes through Composio (SaaS).
  - Payments use Stripe Link single-use cards for an exact amount.
- **Memory:** `memory/MEMORY.md` plus daily journals (markdown the owner can edit); a digest goes into the prompt.
  No embeddings.
- **Approvals and trust:**
  - Seven trust tiers.
  - The policy check runs twice: once to filter which tools the model sees, and again in `beforeToolCall`.
  - An approval is bound to the exact call (conversation, tool, args hash, 2 h TTL, amounts within 5%) and can only
    be settled from the owner's 1:1 channel.
  - Non-owner input is wrapped in `<untrusted>` tags.
  - Every side effect is logged to `audit.jsonl`.

## Side by side
| | Open Instinct / Maritime | biscotti |
|---|---|---|
| Host | Hosted Firecracker VM per user | Pi 5 / self-hosted |
| Harness | pi, one agent per conversation | pi main agent that spawns task agents |
| Messaging | Inkbox | Photon Spectrum |
| Models | Direct provider keys | Vercel AI Gateway with ZDR |
| Connectors | Composio (SaaS) | Self-hosted Executor |
| Secrets | Human takeover + env scrubbing | Vaultwarden + `vault_fill`; Caddy injects keys |
| Browser | One persistent profile in the agent VM | Encrypted per-site profiles in disposable desktops |
| Sandbox | None between agent and desktop | Firecracker snapshot per task, gVisor fallback |
| Memory | Markdown files | Postgres + pgvector |
| Network | Public SaaS chain | Tailscale only |

## Ideas worth stealing (ranked)
1. **Bind each approval to one exact call:** a hash of the tool and args, a TTL, single use, settled only from the
   owner's 1:1 thread. A bare "yes" in a group, email or A2A message never approves anything.
2. **Check policy twice:** hide tools the sender can never use, and still check before each call.
3. **Trust tiers** for anyone other than the owner, with a one-line notice to the owner when something is refused.
4. **`<untrusted>` wrapping** with tag-stripping; per-participant transcripts in groups.
5. **An owner-readable audit log** plus an `audit_read` tool, with a spend policy (ask above $X, a daily cap, blocked
   merchants).
6. **Single-use cards** (Stripe Link) instead of storing card numbers in the vault.
7. **Event-driven wakes with cheap script gates** before calling the model; short idle timeouts for self-started work.
8. **Acknowledge within a reply budget and deliver later**; turn a new text into `steer()` on the running agent.
9. **Hygiene:** strip secret-named env vars from shell tools; an SSRF guard on fetch (block 100.64/10, the Tailscale
   range); an owner-claim code.

## Deliberately not copying
- A persistent agent + desktop VM with logins stored inside (loses per-task isolation).
- Takeover as the *only* credential path (keep it for captchas and 2FA).
- A SaaS trust chain (Inkbox + Composio + Maritime); generated apps deployed publicly; a multi-user gateway.
- Flat-file memory (we have pgvector; at most copy the editable-digest idea).

## Open questions for biscotti
- Do we hash-bind approvals? Do task agents see only the tools they're allowed to use?
- Who besides the owner can reach biscotti via Spectrum (groups, forwarded texts)? Do we need tiers?
- Should we add a live-desktop takeover view (noVNC on the tailnet) for edge cases?
- Single-use cards instead of stored cards? One audit log covering the main agent and task VMs?
- Should page and screenshot content returned to the main agent be wrapped as untrusted?

## Claims vs code
- **Shown in code:** the double policy check, arg-hash approvals, env scrubbing, markdown memory, untrusted wrapping,
  takeover.
- **Claims only:** wake times, "sleeping is free", the cost models.
- **Inconsistent across their own docs:** test counts, tier count, wake time, billing.
