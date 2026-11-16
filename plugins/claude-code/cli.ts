import { spawnSync } from "node:child_process";
import { claude } from "./index.ts";

// The plugin's Claude Code, with its config dir: `node plugins/claude-code/cli.ts auth login` (or `auth status`).
process.exit(spawnSync(claude(), process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
