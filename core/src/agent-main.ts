import { runAgent } from "./agent.ts";

// The main agent on its own (see agent.ts); main.ts runs the gate.
await runAgent(process.env.BISCOTTI_SOCKETS ?? "/run/biscotti", "/tmp/agent");
