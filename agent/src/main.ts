import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { createAgent } from "./agent.ts";
import { openDb } from "./db.ts";
import { memoryTools } from "./memory.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const dir = process.env.DATA_DIR ?? "/data";
const db = openDb(`${dir}/biscotti.db`);
const agent = await createAgent({
  db,
  dir,
  model: process.env.MODEL,
  tools: memoryTools(db, env("EMBEDDINGS_URL")),
});

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
  const text = message.content.text;
  // Not awaited: a text that arrives mid-reply steers the reply already underway.
  space
    .responding(async () => {
      const reply = await agent.reply(text);
      if (reply) await space.send(reply);
    })
    .catch((err) => console.error(err));
}
