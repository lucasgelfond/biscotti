import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in `claude` for pi-claude-code, after its own tests' fake: `auth status` says what `loggedIn` says; `-p`
// answers the initialize control request, then each user frame with `reply` (Anthropic stream events; a string is a
// failing `result` with that text). Each run's environment lands in `log`.
export function fakeClaude(reply: Record<string, unknown>[] | string, opts: { loggedIn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const log = join(dir, "log.jsonl");
  const command = join(dir, "claude");
  writeFileSync(log, "");
  writeFileSync(
    command,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("auth")) {
  console.log(JSON.stringify({ loggedIn: ${opts.loggedIn ?? true}, authMethod: "claude.ai", subscriptionType: "max" }));
  process.exit(${opts.loggedIn === false ? 1 : 0});
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env }) + "\\n");
const reply = ${JSON.stringify(reply)};
const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const out = (o) => console.log(JSON.stringify(o));
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize")
    return out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: [] } } });
  if (frame.type !== "user") return;
  if (typeof reply === "string") return out({ type: "result", subtype: "success", is_error: true, result: reply, usage });
  const content = [];
  for (const event of reply) {
    out({ type: "stream_event", event });
    if (event.type === "content_block_start") content.push({ ...event.content_block });
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") content[event.index].text = (content[event.index].text ?? "") + event.delta.text;
    if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") content[event.index].input = JSON.parse(event.delta.partial_json);
  }
  const stop = reply.find((e) => e.type === "message_delta")?.delta?.stop_reason ?? "end_turn";
  out({ type: "assistant", message: { id: "m_fake", role: "assistant", content, stop_reason: stop, usage } });
  out({ type: "result", subtype: stop === "tool_use" ? "error_max_turns" : "success", is_error: stop === "tool_use", usage });
});
`,
  );
  chmodSync(command, 0o755);
  return { command, runs: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> }) };
}

const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// A reply that says `text`.
export const says = (text: string) => [
  { type: "message_start", message: { id: "m_fake", role: "assistant", content: [], usage } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
  { type: "message_stop" },
];
// A reply that calls the caller's tool `name` with `input`.
export const calls = (name: string, input: object) => [
  { type: "message_start", message: { id: "m_fake", role: "assistant", content: [], usage } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: `mcp__pi__${name}`, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
  { type: "message_stop" },
];
