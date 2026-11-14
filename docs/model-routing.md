# Model routing

Two plugins, each optional and inert unless named in biscotti.json:

- [bifrost](../plugins/bifrost/README.md): Bifrost in front of `LLM_BASE_URL`, with retries and failover. The
  provider layer for the API-key models.
- [switchyard](../plugins/switchyard/README.md): Switchyard picks a model per user turn, with TypeSafe's Jev as the
  judge, among DeepSeek and Qwen (API keys, through Bifrost or the gateway) and Opus and Sonnet (the Claude
  subscription, through Claude Code).

## Architecture

```
main agent / task VMs
        │  OpenAI chat completions, as today
        ▼
      gate ── scrubs secrets, maps main/task/code, observes ──┐
        │ SWITCHYARD_ROLES (+ x-switchyard-session-id)         │ other roles, and every fallback
        ▼                                                      ▼
  Switchyard :4801 ── Jev (TypeSafe /v1/systemone) ── picks a tier
        │                          │
        ▼                          ▼
  Bifrost :4800             Claude Code port :4802 (in the gate, Switchyard's key only)
        │                          │
        ▼                          ▼
  LLM_BASE_URL              claude -p (the owner's subscription)
  (DeepSeek, Qwen)          (Opus, Sonnet)
```

Bifrost sits on both paths: Switchyard's DeepSeek and Qwen go through it, and so does every gate call no other
backend answers (it's an `upstream` backend). Without the bifrost plugin, both go to `LLM_BASE_URL` directly.

The gate tries, in order, a plugin's backend for the model (switchyard, claude-code), then the upstream one
(bifrost), then `LLM_BASE_URL`. A backend that answers 402, 429 or 503 (out of usage, rate-limited, down) is skipped
for that model for `LLM_FALLBACK_MIN` minutes. The switchyard backend answers 503 whenever Switchyard or Jev fails
(not for the request's own 400/413/422), so a routing failure becomes the role's usual model, never an error.

No loop: Switchyard reaches Claude Code at a port of the switchyard plugin's, which runs `claude -p` with the
claude-code plugin's code and never calls the gate's model.

Sessions: the gate knows each call's slot and task, and sends `biscotti-main` or `biscotti-task-<n>`. Switchyard
judges at each new user message (`user_turn`) and keeps the choice for the turn's tool calls; a task's turn is its
goal, so a task keeps its model, and each owner message to the main agent is judged anew.

Both services listen on 127.0.0.1. Bifrost is the official arm64 image (v2.4.0, pinned by digest); Switchyard is
built from source on the Pi at v0.4.0-rc.2, the first version with Jev decisions (no binary or image is published).

## Comparing fixed models with auto routing on EverydayBench

The bench (tests/bench/cu.ts) runs EverydayBench's errands in task VMs with one model for every call, and grades
each from the sites' databases. `CU_PLUGINS` loads plugins' model backends too, so the same runs can be routed.

1. **Setups**, same guidance (`qbh`), same tasks, three runs each (`CU_RUN=1..3`), on the Pi with the live agent
   stopped (as for every bench run; the switchyard plugin's Claude Code port must be free), with the settings from
   `/var/lib/biscotti/.env` (`DB_KEY` among them: the port's key comes from it), and Switchyard and Bifrost up:
   - Fixed DeepSeek: `node tests/bench/cu.ts deepseek/deepseek-v4.1-flash-1017-fast qbh`
   - Fixed Qwen: `node tests/bench/cu.ts <qwen id> qbh`
   - Fixed Sonnet and fixed Opus: `CU_PLUGINS=secure-fill,vision,lessons,claude-code CLAUDE_CODE_MODELS=task=sonnet`
     (then `task=opus`) `CU_LABEL=sonnet node tests/bench/cu.ts deepseek/deepseek-v4.1-flash-1017-fast qbh`
   - Auto: `CU_PLUGINS=secure-fill,vision,lessons,switchyard SWITCHYARD_ROLES=task CU_LABEL=auto node tests/bench/cu.ts
     deepseek/deepseek-v4.1-flash-1017-fast qbh` (the model named is the fallback when routing fails)
   - Auto, Task routing (Opus or DeepSeek, Jev's probability against a cutoff): as Auto, with
     `SWITCHYARD_ALGORITHM=task` in Switchyard's settings (restart setup), `CU_LABEL=auto-task`.
2. **Measure**: pass rate and partial progress per task (report.ts), wall time, model calls and tokens. For auto,
   which model served each task, from the decision log in the run's scratch directory (`switchyard.jsonl`) and from
   Switchyard's `routing.jsonl` (its tokens per model). Dollar cost: the API models' tokens at report.ts's prices;
   the Claude ones counted separately, as calls and tokens against the subscription's limits (the bench's
   per-call `cost` from the gateway isn't passed back through Switchyard). Also count fallbacks (gate log lines
   `the plugin's backend answered 503`): a run that fell back isn't measuring routing.
3. **Read it as**: auto is worth it if it matches the best fixed model's pass rate within noise at a clearly lower
   API cost or subscription use, or beats the cheap models' pass rate at a small extra cost. Look per task at where
   Jev's tier disagreed with the fixed model that passed; those are the tier names (`TIERS` in the plugin) to
   adjust, then rerun only those tasks.
4. **Before the bench**, a dry week of the live agent with `SWITCHYARD_ROLES=task`, then `main,task,code`, reading
   the decision logs, shows how Jev routes real traffic and whether the latency of a decision per user turn
   (one Jev call, budget 10 s) is acceptable.
