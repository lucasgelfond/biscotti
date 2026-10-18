import { Spectrum, type Space } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { createAgent } from "./agent.ts";
import { executor } from "./connectors.ts";
import { openDb } from "./db.ts";
import { memoryTools } from "./memory.ts";
import { taskTool } from "./sandbox.ts";
import { ensureVaultAccount } from "./vault.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const dir = process.env.DATA_DIR ?? "/data";
const db = openDb(`${dir}/biscotti.db`);
if (process.env.VAULT_URL) {
  const account = await ensureVaultAccount(process.env.VAULT_URL, env("VAULT_EMAIL"), env("VAULT_PASSWORD"));
  console.log(`vault account ${account}`);
}
const agent = await createAgent({
  db,
  dir,
  model: process.env.MODEL,
  tools: [
    ...memoryTools(db, env("EMBEDDINGS_URL")),
    ...(process.env.VM_DIR
      ? [taskTool(process.env.VM_DIR, env("FIRECRACKER"), (goal, report) => deliver(`Task report (${goal}):\n${report}`))]
      : []),
  ],
  extensions: process.env.EXECUTOR_URL ? executor(process.env.EXECUTOR_URL, env("EXECUTOR_API_KEY")) : [],
});

// The owner's conversation, where replies to task reports go.
let ownerSpace: Space | undefined;
async function deliver(text: string) {
  try {
    const reply = await agent.reply(text);
    if (reply && ownerSpace) await ownerSpace.send(reply);
  } catch (err) {
    console.error(err);
  }
}

const owner = env("OWNER");
const app = await Spectrum({
  projectId: env("SPECTRUM_PROJECT_ID"),
  projectSecret: env("SPECTRUM_PROJECT_SECRET"),
  providers: [imessage.config()],
});

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound" || message.content.type !== "text") continue;
  if (message.sender?.id !== owner) {
    console.warn(`ignoring message from ${message.sender?.id}`);
    continue;
  }
  ownerSpace = space;
  const text = message.content.text;
  // Not awaited: a text that arrives mid-reply steers the reply already underway.
  space
    .responding(async () => {
      const reply = await agent.reply(text);
      if (reply) await space.send(reply);
    })
    .catch((err) => console.error(err));
}
