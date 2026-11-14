# bifrost

Runs [Bifrost](https://github.com/maximhq/bifrost) (Apache-2.0), an OpenAI-compatible gateway, in front of your
`LLM_BASE_URL`. The gate's model calls that no other plugin answers go through it: it retries the gateway on rate
limits and 5xx errors (twice, with backoff) and, if you set them, fails over to other models or a second provider.
It is also the provider layer for the [switchyard](../switchyard/README.md) plugin's API-key models (DeepSeek, Qwen).

How it's wired: the plugin is an *upstream* model backend (`Llm.upstream` in core/src/plugin.ts). Another plugin's
backend (claude-code, switchyard) still answers first for the models it names; whatever it can't answer (402, 429,
503) goes to Bifrost, and when Bifrost itself is down or answers 503, the gate calls `LLM_BASE_URL` directly, as it
does without this plugin, for `LLM_FALLBACK_MIN` minutes (default 10). So a stopped or misconfigured Bifrost slows
nothing down for long and never takes biscotti down. (Pointing `LLM_BASE_URL` at Bifrost would have been simpler, but
then Bifrost being down would be biscotti being down.)

Bifrost v2.4.0 (`maximhq/bifrost`, pinned by digest in compose.yaml) has linux/arm64 and linux/amd64 images. It
listens on 127.0.0.1:4800 only. Its config.json is written from `/var/lib/biscotti/.env` by a one-shot
`bifrost-config` container before Bifrost starts (into `/var/lib/biscotti/bifrost/`, readable by Bifrost's user
alone). It keeps no database and no request logs: config.json is all of its configuration.

## Turning it on

1. Add `"bifrost"` to the plugins in `/var/lib/biscotti/biscotti.json`.
2. `systemctl restart biscotti-setup` (it pulls the image, writes the config and starts Bifrost), then
   `docker restart biscotti-gate-1`, so the gate loads the plugin (setup recreates the gate only when its own
   settings change).

Nothing else is needed: it reuses `LLM_BASE_URL`, `LLM_API_KEY`, `MODEL`, `TASK_MODEL`, `CODE_MODEL` and `LLM_EXTRA`.
To turn it off, take it out of biscotti.json and do step 2 again (setup removes the Bifrost containers).

## Settings (in /var/lib/biscotti/.env, all optional)

- `BIFROST_FALLBACKS`: models to try, in order, when the gateway fails a call for good, each `provider/model` in
  Bifrost's names: `gateway/<id>` for one on `LLM_BASE_URL`, `backup/<id>` for one on the backup. E.g.
  `gateway/qwen/qwen3.8-27b` (use your gateway's real id).
- `BIFROST_BACKUP_URL`, `BIFROST_BACKUP_KEY`: a second OpenAI-compatible provider (e.g. `https://openrouter.ai/api/v1`
  and its key), as `backup` for `BIFROST_FALLBACKS`.
- `BIFROST_URL`: where the gate reaches Bifrost (default `http://127.0.0.1:4800`).

A changed setting takes `systemctl restart biscotti-setup` (the config is written when Bifrost starts).

## Checking on it

```sh
curl -s http://127.0.0.1:4800/health
docker logs --tail 50 biscotti-bifrost-1
docker logs biscotti-gate-1 2>&1 | grep "plugin's backend answered"   # the gate falling back past it
```

## Tested, and not

Tested here (tests/model-routing.test.ts): the generated config.json; the gate going through Bifrost with the
fallbacks and `LLM_EXTRA`, and straight to `LLM_BASE_URL` when it's down; another backend's 429 going to Bifrost.
With `BIFROST_BIN` set, the real Bifrost v2.4.0 (the macOS binary) ran that config against a stand-in gateway,
plain and streamed.

Not tested: the Docker image on the Pi (compose, the config container, file ownership), the owner's real gateway
(Vercel AI Gateway) behind it, `BIFROST_FALLBACKS` and the backup provider against real failures, and whether
`LLM_EXTRA` fields reach the gateway as they do without Bifrost (they're passed through with
`x-bf-passthrough-extra-params`).
