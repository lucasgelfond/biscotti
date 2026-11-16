import { createServer } from "node:http";
import { pipeUpgrade } from "../core/src/http.ts";
import { model } from "./stand-in-model.ts";
import { standInVms } from "./stand-in-vm.ts";

// biscotti on this machine for working on its apps: the real gate and agent, the stand-in model, stand-in task VMs
// (stand-in-vm.ts: "start a task: run `ls`" makes a sandbox; ssh-vms' VMs open too, though there's no sshd behind
// them), and the Agent Host Protocol on DEV_AHP_PORT (7781) of localhost, passed through as the gate does from the
// tailnet (no login check).
// Run: node tests/dev-host.ts
const { boot } = await import("./support.ts");
const { say, sockets } = await boot(["ssh-vms"], { vms: (await standInVms()).host });
await say("hello from the dev host");
const port = Number(process.env.DEV_AHP_PORT ?? 7781);
const server = createServer((_req, res) => res.writeHead(404).end());
server.on("upgrade", (req, socket, head) => pipeUpgrade(req, socket, head, `${sockets}/agent.sock`, { path: "/ahp" }));
server.listen(port, "127.0.0.1", () => console.log(`AHP at ws://127.0.0.1:${port}/ahp (stand-in model at ${(model.address() as { port: number }).port})`));
