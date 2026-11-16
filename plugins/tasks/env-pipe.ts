import { connect } from "node:net";

// pi-env's daemon in VM <id>, as a command for the agent's pi-env `Connection`: stdin and stdout piped through the
// gate's socket (/env/<id>), which runs the daemon over SSH (vm-env.ts) with the arguments the `Connection` adds
// (`serve --token <hex>`). Usage: node env-pipe.ts <sockets dir> <id> <daemon arguments…>
// TODO: something smaller than a Node process per run to splice bytes (or a duplex transport from pi-env).
const [sockets, id, ...args] = process.argv.slice(2);
const request = [`GET /env/${encodeURIComponent(id)} HTTP/1.1`, "Host: gate", "Connection: Upgrade", "Upgrade: pi-env", `Pi-Env-Arguments: ${args.join(" ")}`];
const socket = connect(`${sockets}/gate.sock`, () => socket.write(`${request.join("\r\n")}\r\n\r\n`));
let head = Buffer.alloc(0);
const answered = (chunk: Buffer) => {
  head = Buffer.concat([head, chunk]);
  const end = head.indexOf("\r\n\r\n");
  if (end < 0) return;
  socket.off("data", answered);
  if (!head.subarray(0, end).toString().startsWith("HTTP/1.1 101")) {
    process.stderr.write(`the gate refused pi-env for VM ${id}: ${head.subarray(0, end).toString().split("\r\n")[0]}\n`);
    process.exit(1);
  }
  const rest = head.subarray(end + 4);
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
};
// Either side gone (the agent's Connection closed, or the gate) ends the pipe.
for (const stream of [process.stdin, process.stdout]) stream.on("error", () => process.exit(0));
process.stdin.on("end", () => socket.end());
socket.on("data", answered);
socket.on("error", (err) => (process.stderr.write(`${err.message}\n`), process.exit(1)));
socket.on("close", () => process.exit(0));
