// Texts the owner from outside the agent, e.g. during setup: node notify.ts "message". Only while the agent is
// stopped: this opens a second Photon connection, and the running agent stops receiving messages.
import { connect } from "./index.ts";

const channel = await connect((name) => process.env[name] ?? "");
await channel.send({ text: process.argv[2] });
process.exit(0);
