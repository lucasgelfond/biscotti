import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { SERVER, type Frame, type Tool } from "./openai.ts";

// Runs one model call as `claude -p` that only talks to the model: no tools of its own, no settings, CLAUDE.md, memory
// or session saved; the caller's tools offered through an MCP server that can't run them (inert-mcp.mjs), the history
// replayed as stream-json frames, and the process stopped at the reply's first message_stop, before Claude Code would
// act on a tool call. The flags and environment follow pi-claude-code (github.com/earendil-works/pi-claude-code, MIT).

export const INSTALL_HINT = "Claude Code isn't installed: set CLAUDE_CODE_COMMAND to its executable.";
export const LOGIN_HINT = "Claude Code isn't logged in: run `claude auth login` with this CLAUDE_CONFIG_DIR (see plugins/claude-code/README.md).";

export class ClaudeError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface Config {
  command: string;
  configDir?: string;
  env: Record<string, string | undefined>;
  // A call that goes this long without a line from Claude Code is stopped.
  idleMs: number;
  allowUsageCredits: boolean;
}

// The binary the plugin's @anthropic-ai/claude-code brought for this platform (its postinstall, which would link it,
// doesn't run under pnpm).
export function bundledClaude(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve("@anthropic-ai/claude-code/package.json");
    const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
    const musl = process.platform === "linux" && !header?.glibcVersionRuntime;
    const native = createRequire(pkg).resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}${musl ? "-musl" : ""}/package.json`);
    return join(dirname(native), "claude");
  } catch {
    return undefined;
  }
}

// Only what Claude Code needs: none of the gate's keys, and nothing that would switch its login or billing
// (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, Bedrock, Vertex…).
const PASSED = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_OAUTH_TOKEN", "MAX_THINKING_TOKENS"];
function environment(cfg: Config, maxTokens?: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) if (cfg.env[name]) env[name] = cfg.env[name]!;
  if (cfg.configDir) env.CLAUDE_CONFIG_DIR = cfg.configDir;
  Object.assign(env, {
    CLAUDE_CODE_ENTRYPOINT: "biscotti",
    ENABLE_TOOL_SEARCH: "false",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
  });
  if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  return env;
}

const kill = (child: ChildProcess) => {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

async function capture(cfg: Config, args: string[]) {
  const child = spawn(cfg.command, args, { env: environment(cfg), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise<number>((resolve, reject) => child.once("error", reject).once("close", (c) => resolve(c ?? 1)));
    return { code, out };
  } catch (err) {
    throw (err as NodeJS.ErrnoException).code === "ENOENT" ? new ClaudeError(INSTALL_HINT, 503) : err;
  } finally {
    clearTimeout(timer);
  }
}

// `claude auth status`: installed, logged in, and with which plan.
export async function status(cfg: Config): Promise<{ loggedIn: boolean; plan?: string; detail?: string }> {
  try {
    const { out } = await capture(cfg, ["auth", "status"]);
    const said = JSON.parse(out.slice(Math.max(0, out.indexOf("{"))) || "{}");
    return said.loggedIn === true ? { loggedIn: true, plan: said.subscriptionType } : { loggedIn: false, detail: LOGIN_HINT };
  } catch (err) {
    return { loggedIn: false, detail: err instanceof ClaudeError ? err.message : `Claude Code's status check failed: ${err}` };
  }
}

// Per Claude Code install and login: until when its last good check holds (a minute, so most calls don't wait on
// another process), and, after a reply charged to usage credits rather than the plan's limits, until when calls stop.
const ready = new Map<string, number>();
const creditsUntil = new Map<string, number>();
const install = (cfg: Config) => `${cfg.command}\0${cfg.configDir}`;
async function check(cfg: Config) {
  if (Date.now() < (ready.get(install(cfg)) ?? 0)) return;
  const s = await status(cfg);
  if (!s.loggedIn) throw new ClaudeError(s.detail ?? LOGIN_HINT, 503);
  ready.set(install(cfg), Date.now() + 60_000);
}

const CREDITS =
  "Claude Code billing: this call was charged to Claude usage credits instead of the plan's limits, so the gate stops " +
  "calling Claude Code until the limit resets. Turn off usage credits at claude.ai/settings/usage, or set CLAUDE_CODE_ALLOW_USAGE_CREDITS=1.";
const CREDITS_REJECTION = /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i;

export interface Call {
  model: string;
  system: string;
  frames: Frame[];
  tools: Tool[];
  maxTokens?: number;
  signal: AbortSignal;
  // Each Anthropic stream event of the reply, in order, through its message_stop.
  onEvent(event: Record<string, unknown>): void;
}

export async function run(cfg: Config, call: Call): Promise<void> {
  if (Date.now() < (creditsUntil.get(install(cfg)) ?? 0) && !cfg.allowUsageCredits) throw new ClaudeError(CREDITS, 402);
  await check(cfg);
  call.signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "claude-code-"));
  const toolsPath = join(root, "tools.json");
  const systemPath = join(root, "system.md");
  await Promise.all([writeFile(toolsPath, JSON.stringify(call.tools)), writeFile(systemPath, call.system)]);
  const mcp = { mcpServers: { [SERVER]: { command: process.execPath, args: [new URL("./inert-mcp.mjs", import.meta.url).pathname, toolsPath] } } };
  const args = [
    "-p",
    ...(call.model === "default" ? [] : ["--model", call.model]),
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--system-prompt-file", systemPath,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--max-turns", "1",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--mcp-config", JSON.stringify(mcp),
  ];
  const child = spawn(cfg.command, args, { cwd: root, env: environment(cfg, call.maxTokens), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stdin!.on("error", () => {});
  child.stderr!.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
  const spawned = new Promise<never>((_, reject) =>
    child.once("error", (err: NodeJS.ErrnoException) => reject(err.code === "ENOENT" ? new ClaudeError(INSTALL_HINT, 503) : err)),
  );
  spawned.catch(() => {});
  const stop = () => kill(child);
  call.signal.addEventListener("abort", stop, { once: true });
  let idle: NodeJS.Timeout | undefined;
  let timedOut = false;
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, unknown> | undefined> => {
    for (;;) {
      clearTimeout(idle);
      idle = setTimeout(() => ((timedOut = true), stop()), cfg.idleMs);
      const line = await Promise.race([lines.next(), spawned]);
      if (line.done) return undefined;
      if (!line.value.trim()) continue;
      try {
        return JSON.parse(line.value);
      } catch {
        throw new ClaudeError(`Claude Code wrote something other than stream-json: ${line.value.slice(0, 300)}`);
      }
    }
  };
  const ended = (what: string) =>
    new ClaudeError(`${timedOut ? `Claude Code went quiet for ${cfg.idleMs / 1000}s` : `Claude Code exited ${what}`}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);

  try {
    for (const frame of call.frames) {
      child.stdin!.write(`${JSON.stringify({ ...frame, uuid: randomUUID() })}\n`);
      if (frame.shouldQuery !== false) continue;
      for (;;) {
        const e = await next();
        if (!e) throw ended("while it read the conversation");
        if (e.type !== "result") continue;
        if (e.is_error || e.num_turns !== 0) throw new ClaudeError(`Claude Code didn't take the conversation's history: ${e.result ?? e.subtype}`);
        break;
      }
    }
    let started = false;
    let error: string | undefined;
    let errorKind: string | undefined;
    for (;;) {
      const e = await next();
      if (!e) throw ended("before it replied");
      if (e.type === "stream_event") {
        const event = e.event as Record<string, unknown>;
        started = true;
        call.onEvent(event);
        if (event.type === "message_stop") return;
      } else if (e.type === "rate_limit_event") {
        const info = e.rate_limit_info as { isUsingOverage?: boolean; resetsAt?: number } | undefined;
        if (info?.isUsingOverage && !cfg.allowUsageCredits) {
          creditsUntil.set(install(cfg), info.resetsAt ? info.resetsAt * 1000 : Date.now() + 60 * 60_000);
          if (!started) throw new ClaudeError(CREDITS, 402);
        }
      } else if (e.type === "assistant" && (e.error || (e.message as Record<string, unknown>)?.error)) {
        errorKind = String(e.error ?? (e.message as Record<string, unknown>).error);
        const content = ((e.message as { content?: { type: string; text?: string }[] })?.content ?? []).filter((b) => b.type === "text");
        error = content.map((b) => b.text).join("\n") || errorKind;
      } else if (e.type === "result") {
        const said = error ?? String(e.result ?? e.subtype ?? "no reply");
        if (CREDITS_REJECTION.test(said)) throw new ClaudeError(`Claude Code billing: Anthropic wants to charge this call to usage credits rather than the plan. ${said}`, 402);
        if (errorKind === "rate_limit" || /usage limit|rate limit/i.test(said)) throw new ClaudeError(`Claude Code: ${said}`, 429);
        if (errorKind === "authentication_failed" || /\/login|not logged in|invalid api key/i.test(said)) {
          ready.delete(install(cfg));
          throw new ClaudeError(`${LOGIN_HINT} (${said})`, 503);
        }
        throw new ClaudeError(`Claude Code: ${said}`);
      }
    }
  } finally {
    clearTimeout(idle);
    call.signal.removeEventListener("abort", stop);
    stop();
    await rm(root, { recursive: true, force: true });
  }
}
