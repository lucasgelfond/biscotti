#!/usr/bin/env node
// Claude Code with only what it needs of the gate's environment: pi-claude-code starts it with all of it (every key
// the gate holds), so the plugin points PI_CLAUDE_CODE_COMMAND here. CLAUDE_CODE_REAL is the executable.
import { spawn } from "node:child_process";

const KEEP = /^(PATH|HOME|USER|LANG|LC_ALL|TZ|TMPDIR|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|MAX_THINKING_TOKENS|ENABLE_TOOL_SEARCH|CLAUDE_CONFIG_DIR|CLAUDE_CODE_[A-Z_]+|DISABLE_[A-Z_]+)$/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k) && k !== "CLAUDE_CODE_REAL"));
const child = spawn(process.env.CLAUDE_CODE_REAL, process.argv.slice(2), { stdio: "inherit", env });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
