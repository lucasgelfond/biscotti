import { runAgent } from "./agent.ts";

// The main agent on its own (see agent.ts); main.ts runs the gate. Its database is its own, under its own key.
const key = process.env.AGENT_DB_KEY;
if (!key) throw new Error("AGENT_DB_KEY is not set");
await runAgent(process.env.BISCOTTI_SOCKETS ?? "/run/biscotti", { dir: process.env.DATA_DIR ?? "/data", key });
