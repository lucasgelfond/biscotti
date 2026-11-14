# switchyard

Routes the gate's model calls between four models with NVIDIA's
[Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) (Apache-2.0), with TypeSafe's Jev as the judge:

| Target | Model | Through |
|---|---|---|
| `deepseek` | DeepSeek v4.1 flash (`deepseek/deepseek-v4.1-flash-1017-fast`) | your gateway (`LLM_BASE_URL`), or [Bifrost](../bifrost/README.md) when that plugin is on |
| `qwen` | Qwen 3.8 27B (`SWITCHYARD_QWEN_MODEL`, **a placeholder until you set it**) | the same |
| `sonnet` | Claude Sonnet 5.5 (Claude Code's `sonnet` alias; `SWITCHYARD_SONNET_MODEL` pins a full id) | your Claude subscription, by Claude Code |
| `opus` | Claude Opus 5.5 (Claude Code's `opus` alias, or `SWITCHYARD_OPUS_MODEL`, e.g. `claude-opus-5-5`) | the same |

At each new user message (the owner's, or a task's goal), Switchyard asks Jev which of four tiers should serve the
turn, and keeps that model for the turn's tool calls:

| Tier (what Jev is shown) | Serves | Falls back to |
|---|---|---|
| simple (chat, lookups, short replies) | qwen | deepseek |
| routine (browsing, tool use, everyday errands) | deepseek | qwen |
| demanding (careful writing, coding, multi-step plans) | sonnet | deepseek |
| hardest (deep reasoning, hard debugging, high stakes) | opus | sonnet, deepseek |

This is Switchyard's `llm_classifier` route in `direct` mode with Jev as its decision target: Jev picks one option
of four, and Switchyard serves that tier's first model, falling through the rest of the tier (then any model) when a
call fails, e.g. Claude Code being logged out or over its limit. Jev is told only each tier's name, so the names are
the policy; edit `TIERS` in index.ts to change them. `SWITCHYARD_ALGORITHM=task` uses Switchyard's Task routing
instead (Jev's capable-or-efficient probability against a cutoff, between two models), for comparison.

## How a call goes

The gate → this plugin's backend (for `SWITCHYARD_ALIAS` and `SWITCHYARD_ROLES`) → Switchyard at 127.0.0.1:4801,
with `x-switchyard-session-id`: `biscotti-main` for the main agent, `biscotti-task-<n>` for task n's VM (so a task
keeps its model), `biscotti-slot-<n>` for a VM with no task. Switchyard asks Jev, then calls the chosen target:

- DeepSeek and Qwen: the gateway, or Bifrost (127.0.0.1:4800) when `bifrost` is in biscotti.json.
- Opus and Sonnet: a port this plugin opens in the gate, 127.0.0.1:4802, that runs `claude -p` with the claude-code
  plugin's code (no tools of its own, the caller's tools offered inertly, as that plugin does). It only takes
  Switchyard's key (derived from `DB_KEY`) and never calls the gate's model, so nothing loops back into Switchyard.
  Calls through it are already scrubbed of saved secrets: they came through the gate.

If Switchyard is down, or answers with an error that isn't the request's own fault (Jev unreachable, out of time or
refusing the key, every model failing), the backend answers 503 and the gate falls back: to Bifrost if it's on, else
to `LLM_BASE_URL`, with that role's usual model (`MODEL`, `TASK_MODEL`, `CODE_MODEL`), for `LLM_FALLBACK_MIN`
minutes (default 10). The alias itself (`auto`) has no usual model, so a call for it fails instead.

Switchyard v0.4.0-rc.2 (commit `62e59f6`) is built from source on the machine (Dockerfile): the project publishes no
release binary or container image, and v0.3.0, the last release on crates.io, predates Jev (`system_one`) decisions.
The first build on a Pi 5 takes a while (it compiles a Rust workspace; minutes on a laptop, likely 15-30 on the
Pi); later boots reuse the image. It runs on the host's network, listening on 127.0.0.1:4801 only. Its config is
written from `/var/lib/biscotti/.env` by a one-shot `switchyard-config` container before it starts, into
`/var/lib/biscotti/switchyard/` (`switchyard.toml`, and the keys in `switchyard.env`, readable by its user alone).

## Jev: TypeSafe directly

Switchyard's `system_one` client sends `POST <endpoint>` with `Authorization: Bearer <key>` and
`{model, state, questions: {route: {type: "choice", instructions, criteria}}}`, and reads
`answers.route.{type, choice, probabilities, confidence}`: the same System One API as TypeSafe's `/v1/systemone`,
which jev-quick-browse calls, and Switchyard's own docs configure `https://api.typesafe.ai/v1/systemone` with
`TYPESAFE_API_KEY`. So by default Jev is called at `TYPESAFE_URL` (default `https://api.typesafe.ai`) with your
`TYPESAFE_API_KEY` and `TYPESAFE_MODEL` (default `jev-latest`). Not verified against the live API here (no key on
this machine): if TypeSafe's answers lacked the `type` field, every decision would fail and calls would fall back
(see below for how to tell). Through OpenRouter instead:

```sh
SWITCHYARD_JEV_URL=https://openrouter.ai/api/alpha/decisions
SWITCHYARD_JEV_KEY=<your OpenRouter key>
SWITCHYARD_JEV_MODEL=typesafe/jev-1.13
```

## Turning it on

1. In `/var/lib/biscotti/.env`, set `SWITCHYARD_ROLES` (which of the gate's models it routes; start with `task` to
   try it on tasks first, then `main,task,code`) and `SWITCHYARD_QWEN_MODEL` (your gateway's id for Qwen 3.8 27B).
   `TYPESAFE_API_KEY` is already there.
2. Add `"switchyard"` to the plugins in `/var/lib/biscotti/biscotti.json` (and `"bifrost"` too, if you want its
   retries in between). If `claude-code` is in there as well, either take it out (switchyard runs Claude Code
   itself) or set `CLAUDE_CODE_MODELS` to roles that switchyard doesn't route: for a role both name, the plugin
   listed later answers.
3. `systemctl restart biscotti-setup` (it builds the image, the first time, writes the config and starts
   Switchyard), then `docker restart biscotti-gate-1`, so the gate loads the plugin.
4. Claude Code needs a login, once, as for the claude-code plugin:
   `docker exec -it biscotti-gate-1 node plugins/claude-code/cli.ts auth login` (or `CLAUDE_CODE_OAUTH_TOKEN` in
   .env). Without one, the Claude tiers fall through to DeepSeek.

To turn it off, take it out of biscotti.json and do step 3 again (setup removes the Switchyard containers).

## Settings (in /var/lib/biscotti/.env)

- `SWITCHYARD_ROLES`: the gate's models (`main`, `task`, `code`) it answers, e.g. `main,task,code`; default none.
- `SWITCHYARD_ALIAS`: the model name it always answers, and Switchyard's route id (default `auto`).
- `SWITCHYARD_DEEPSEEK_MODEL` (default `deepseek/deepseek-v4.1-flash-1017-fast`), `SWITCHYARD_QWEN_MODEL` (default
  `qwen/qwen3.8-27b`, a placeholder): gateway ids. `SWITCHYARD_SONNET_MODEL` (default `sonnet`),
  `SWITCHYARD_OPUS_MODEL` (default `opus`): Claude Code model names or full ids.
- `SWITCHYARD_TRIGGER`: when Jev decides: `user_turn` (default: each new user message, kept through its tool calls),
  `new_session` (once per task; the main agent would never change model), `every_request`.
- `SWITCHYARD_WINDOW`: how many of the conversation's latest messages Jev reads besides its first (default 1, the
  new message: more carries tool results and screenshots).
- `SWITCHYARD_DEFAULT`: the tier when Jev can't decide and `SWITCHYARD_FAIL_OPEN=1` (default `routine`).
- `SWITCHYARD_FAIL_OPEN=1`: when Jev fails, serve the default tier instead of answering 503 (so no fallback).
- `SWITCHYARD_ALGORITHM=task`: Task routing; `SWITCHYARD_CAPABLE` (default `opus`), `SWITCHYARD_EFFICIENT` (default
  `deepseek`), `SWITCHYARD_CUTOFF` (default 0.6).
- `TYPESAFE_URL`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`; or `SWITCHYARD_JEV_URL`, `SWITCHYARD_JEV_KEY`,
  `SWITCHYARD_JEV_MODEL`; `SWITCHYARD_JEV_TIMEOUT_MS` (default 10000).
- Claude Code's own: `CLAUDE_CODE_CONCURRENCY`, `CLAUDE_CODE_IDLE_MS`, `CLAUDE_CODE_ALLOW_USAGE_CREDITS` (see
  [claude-code](../claude-code/README.md)).

A changed setting takes `systemctl restart biscotti-setup` (Switchyard's config is written when it starts).

## The decision log

Two, side by side:

- The gate's, one line per call: the gate's model name, the session, and the model that answered (or why none
  did). In the gate's log, and as JSONL in `/var/lib/biscotti/data/switchyard.jsonl`:

  ```sh
  docker logs biscotti-gate-1 2>&1 | grep '^switchyard:'
  sudo jq -c '[.at, .name, .session, .model // .status]' /var/lib/biscotti/data/switchyard.jsonl | tail -50
  sudo jq -r '.model' /var/lib/biscotti/data/switchyard.jsonl | sort | uniq -c   # how often each model served
  ```

- Switchyard's own routing log, `/var/lib/biscotti/switchyard/routing.jsonl`: every model call it made (Jev's
  included) with its session, target and tokens, and for each decision an `outcome` record whose
  `evidence.selected` is the tier Jev picked:

  ```sh
  sudo jq -c 'select(.outcome) | [.outcome.ts, .session_id, .outcome.evidence.selected // .outcome.evidence.reason_code]' /var/lib/biscotti/switchyard/routing.jsonl | tail
  docker logs --tail 50 biscotti-switchyard-1
  ```

Jev's confidence isn't in either: in `direct` mode Switchyard keeps Jev's choice and drops its probabilities. A
decision that failed shows as a `reason_code` (fail-open) or as a 5xx line in the gate's log, followed by the gate's
`the plugin's backend answered 503` line.

## Tested, and not

Tested here (tests/model-routing.test.ts, against stand-ins): the generated TOML and keys; the session header for the
main agent, a task and a bare slot; the decision log; 503 (and so the gate's fallback) when Switchyard is down or
failing, but not for the request's own 400; Claude Code's port refusing other keys. With `SWITCHYARD_BIN` and
`BIFROST_BIN` set, the real switchyard-server (v0.4.0-rc.2, built on macOS) and Bifrost ran the generated config
end to end with a stand-in Jev, gateway and `claude`: Jev's request shape, a task keeping its tier through a tool
call, the hardest tier served by Claude Code (streamed), its fall-through to DeepSeek when Claude Code is logged
out, and the gate's fallback when Jev fails.

Not tested: the live Jev API (the wire format is read from both sides' code, not tried), real Claude Code through
Switchyard (the translation of a long conversation with images and tool calls into Claude Code's frames), the Docker
build and the containers on the Pi, and how well the four tier names route real traffic.
