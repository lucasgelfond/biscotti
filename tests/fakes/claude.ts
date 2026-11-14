import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in `claude` executable: `auth status` says what `loggedIn` says, and `-p` acknowledges each history frame
// as Claude Code does, then replays `reply` (stream-json lines) for the frame it should answer, and keeps running (as
// Claude Code would, to act on a tool call) until it's stopped. What it was run with lands in `log`.
export function fakeClaude(reply: unknown[], opts: { loggedIn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const log = join(dir, "log.jsonl");
  const command = join(dir, "claude");
  writeFileSync(join(dir, "reply.json"), JSON.stringify(reply));
  writeFileSync(log, "");
  writeFileSync(
    command,
    `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: ${opts.loggedIn ?? true}, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(${opts.loggedIn === false ? 1 : 0});
}
log({ args, env: process.env, system: readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8"),
  tools: JSON.parse(readFileSync(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.gate.args[1], "utf8")) });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", tools: [] });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    log({ frame });
    if (frame.type !== "user") continue;
    if (frame.shouldQuery === false) out({ type: "result", subtype: "success", is_error: false, num_turns: 0 });
    else for (const line of JSON.parse(readFileSync(${JSON.stringify(join(dir, "reply.json"))}, "utf8"))) out(line);
  }
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(command, 0o755);
  const entries = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { command, entries };
}

// Claude Code's stream-json for a reply of Anthropic stream events (with --include-partial-messages).
export const streamed = (events: Record<string, unknown>[]) => events.map((event) => ({ type: "stream_event", event, session_id: "s", parent_tool_use_id: null }));
