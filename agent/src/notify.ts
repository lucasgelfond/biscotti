// Texts the owner from outside the running agent, e.g. during setup: node src/notify.ts "message"
import { connectIMessage } from "./imessage.ts";

const { ownerSpace } = await connectIMessage((name) => process.env[name] ?? "");
await ownerSpace.send(process.argv[2]);
process.exit(0);
