import { createServer } from "node:http";
import { connect } from "node:net";
import { model } from "./stand-in-model.ts";

// biscotti on this machine for working on its apps: the real gate and agent, the stand-in model, and the Agent Host
// Protocol on DEV_AHP_PORT (7781) of localhost, passed through as the gate does from the tailnet (no login check).
// Run: node tests/dev-host.ts
const { boot } = await import("./support.ts");
const { say, sockets } = await boot([]);
await say("hello from the dev host");
const port = Number(process.env.DEV_AHP_PORT ?? 7781);
const server = createServer((_req, res) => res.writeHead(404).end());
server.on("upgrade", (req, socket, head) => {
  const upstream = connect(`${sockets}/agent.sock`, () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${req.method} /ahp HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(port, "127.0.0.1", () => console.log(`AHP at ws://127.0.0.1:${port}/ahp (stand-in model at ${(model.address() as { port: number }).port})`));
