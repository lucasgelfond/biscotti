// Texts the owner from outside the running agent, e.g. during setup: node notify.ts "message"
import { connect } from "./index.ts";

const channel = await connect((name) => process.env[name] ?? "");
await channel.send({ text: process.argv[2] });
process.exit(0);
