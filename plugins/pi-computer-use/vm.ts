// In the task VM: fetch pi-computer-use (pinned, checked against npm's hash), then run pi with it on the goal from
// stdin, with only biscotti's gate as an MCP server so its tools don't overlap Playwright's and Cua's. Each tool pi
// uses goes to stderr as progress; what pi says last is the report. Settings for running it outside a VM come from the
// environment.
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const VERSION = "0.5.1";
const INTEGRITY = "sha512-eBYKTUYfLeaCE33TF6CBb0rklXbgS/4GNDsnl+cBTXv6HTkkMc/Gq/ft3RdcDL0hiRmQBwU9Ohx9jWz4r/l9xQ==";
const env = process.env;
const DIR = env.PCU_DIR ?? "/opt/pi/node_modules/@injaneity/pi-computer-use";
const PI = env.PCU_PI ?? "/opt/pi/node_modules/.bin/pi";
const AGENT = env.PCU_AGENT_DIR ?? "/tmp/pcu-agent";
const USER = env.PCU_USER ?? "cua";

const PROMPT = `You are a task agent in a disposable Linux VM; Chromium is open on its desktop, and the requester may be watching.
Use the computer-use tools: observe, then act; each action reports whether it worked, so check before moving on.
The biscotti tools: share_screenshot texts the requester what's on screen; vault_list and vault_fill type saved logins
and cards (never type a password yourself); propose asks the main agent for something only it may do. Before paying,
booking or sending anything the goal didn't clearly ask for, stop and report. End with a short report of what you did
and found, with the facts the requester needs and the URL you ended on.`;

const log = (line: string) => console.error(`pi-computer-use: ${line}`);
let goal = "";
for await (const chunk of process.stdin) goal += chunk;

const tgz = Buffer.from(await (await fetch(`https://registry.npmjs.org/@injaneity/pi-computer-use/-/pi-computer-use-${VERSION}.tgz`)).arrayBuffer());
if (`sha512-${createHash("sha512").update(tgz).digest("base64")}` !== INTEGRITY) throw new Error("pi-computer-use's download doesn't match its pinned hash");
mkdirSync(DIR, { recursive: true });
writeFileSync("/tmp/pcu.tgz", tgz);
execFileSync("tar", ["-xzf", "/tmp/pcu.tgz", "-C", DIR, "--strip-components=1"]);
log(`installed ${VERSION}`);

// The task model, and the gate's tools only.
mkdirSync(AGENT, { recursive: true });
writeFileSync(`${AGENT}/models.json`, readFileSync(env.PCU_MODELS ?? "/home/cua/.pi/agent/models.json"));
writeFileSync(`${AGENT}/mcp.json`, JSON.stringify({ mcpServers: { biscotti: { url: `${env.GATE_URL ?? "http://gate"}/mcp`, exposure: "direct", timeout: 900 } } }));
execFileSync("chmod", ["-R", "a+rX", DIR, AGENT]);

const vars = {
  PI_CODING_AGENT_DIR: AGENT,
  PI_COMPUTER_USE_CDP_PORT: env.PCU_CDP_PORT ?? "9222",
  PI_COMPUTER_USE_LINUX_HELPER_PATH: `${DIR}/prebuilt/linux/${process.arch === "arm64" ? "arm64" : "x64"}/linux-bridge`,
  DISPLAY: ":1",
};
const args = ["--mode", "json", "--no-session", "--model", env.PCU_MODEL ?? "biscotti/task", "-e", `${DIR}/extensions/computer-use.ts`, "--append-system-prompt", PROMPT, goal];
const pi = USER
  ? spawn("runuser", ["-u", USER, "--", "env", `HOME=/home/${USER}`, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), PI, ...args], { stdio: ["ignore", "pipe", "inherit"] })
  : spawn(PI, args, { env: { ...env, ...vars }, stdio: ["ignore", "pipe", "inherit"] });
let report = "";
createInterface({ input: pi.stdout }).on("line", (line) => {
  let event: { type?: string; toolName?: string; isError?: boolean; message?: { role: string; content: { type: string; text?: string }[] } };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "tool_execution_end") log(`${event.toolName}${event.isError ? " (failed)" : ""}`);
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const said = event.message.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
    if (said) report = said;
  }
});
await new Promise((resolve) => pi.on("close", resolve));
console.log(report.trim() || "pi-computer-use ended without a report.");
