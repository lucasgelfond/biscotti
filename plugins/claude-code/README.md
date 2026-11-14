# claude-code

Serves the gate's model calls through your Claude subscription (Pro or Max), by the official Claude Code CLI
(`claude -p`), instead of `LLM_BASE_URL`. The main agent, task VMs and boxes don't change: they still speak OpenAI
chat completions to the gate, and the gate hands the calls it answers to Claude Code. Claude Code runs in the gate's
container, never in a VM, so no credential reaches one.

Claude Code only talks to the model here. It runs no tool of its own: the caller's tools are offered through an MCP
server that runs none of them, and the process is stopped at the end of the reply, so a tool call goes back to the
caller (pi), which runs it as before. The approach is ported from [pi-claude-code](https://github.com/earendil-works/pi-claude-code) (MIT).

> [!WARNING]
> This counts against your subscription's usage limits, the same as using Claude Code yourself. In May 2026
> Anthropic [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
> that `claude -p`, Agent SDK and third-party usage would move to a separate, smaller "Agent SDK credit" billed at
> API rates; it has since put that on hold, with advance notice promised before any change. If it changes, this
> plugin may cost more, stop drawing from your plan, or stop working. If a reply is charged to usage credits
> rather than your plan's limits, the plugin stops calling Claude Code until the limit resets (set
> `CLAUDE_CODE_ALLOW_USAGE_CREDITS=1` to allow it).

## Turning it on

1. Add `"claude-code"` to the plugins in `/var/lib/biscotti/biscotti.json`, and restart setup
   (`systemctl restart biscotti-setup`). The gate's container then has `/var/lib/biscotti/claude` as Claude Code's
   config dir (`CLAUDE_CONFIG_DIR`), kept across restarts and updates.
2. Log in, once, in the gate's container:

   ```sh
   docker exec -it biscotti-gate-1 node plugins/claude-code/cli.ts auth login
   ```

   It prints a link to open on your phone or laptop, and asks for the code that page shows. Check with
   `... cli.ts auth status`. No restart is needed: the next model call picks the login up.

   Or make a long-lived token elsewhere with `claude setup-token` and put it in `/var/lib/biscotti/.env` as
   `CLAUDE_CODE_OAUTH_TOKEN=…` (then restart setup).

Until it's logged in, biscotti texts you so at start, and the calls it answers fail with a 503 that says what to run.

## Settings (in /var/lib/biscotti/.env)

- `CLAUDE_CODE_MODELS`: which of the gate's models it answers, each `name` or `name=model`, e.g.
  `main=opus,code=sonnet` (default `main,task,code`). The rest stay on `LLM_BASE_URL`.
- `CLAUDE_CODE_MODEL`: the Claude model for a bare name (`opus`, `sonnet`, `haiku` or a full id); default, Claude
  Code's own.
- `CLAUDE_CODE_COMMAND`: the Claude Code executable (default: the one this plugin installs).
- `CLAUDE_CONFIG_DIR`: its config dir (setup sets it).
- `CLAUDE_CODE_CONCURRENCY`: Claude Code processes at once (default 4); `CLAUDE_CODE_IDLE_MS`: how long a call may go
  without output before it's stopped (default 180000).

## Limits

- Each call starts a Claude Code process and replays the whole conversation to it: a second or two before the first
  token, more with a long history (screenshots and all). Each process takes a few hundred MB while it runs.
- Claude Code adds its own bits to what the model sees (its identity line, environment notes, reminders such as your
  account's email). Its prompt caching should still mostly hit, as each call replays the same prefix.
- Thinking is replayed only while the gate runs: after a restart, a tool call's thinking from before it is dropped.
- Not supported: `n` > 1, `temperature`/`top_p`/`stop`, `response_format`, `tool_choice`, `reasoning_effort`,
  audio and file inputs. Tool schemas lose `oneOf`/`anyOf`/`allOf` and nullable types.
