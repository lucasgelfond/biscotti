import { attachment, Spectrum, type Space } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { createAgent } from "./agent.ts";
import { connectors, ensureExecutorToken, NO, YES } from "./connectors.ts";
import { openDb } from "./db.ts";
import { memoryTools } from "./memory.ts";
import { startPassThrough } from "./passthrough.ts";
import { taskTool } from "./sandbox.ts";
import { ensureVaultAccount, vaultTools } from "./vault.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const dir = process.env.DATA_DIR ?? "/data";
const db = openDb(`${dir}/biscotti.db`);
const executorUrl = process.env.EXECUTOR_URL;

// The agent's Executor token: EXECUTOR_API_KEY if set, otherwise minted on first start (with the owner's admin account).
async function executorToken(url: string) {
  return (
    process.env.EXECUTOR_API_KEY ||
    ensureExecutorToken(url, env("EXECUTOR_ORIGIN"), `${dir}/executor-token`, {
      name: "biscotti owner",
      email: env("OWNER_EMAIL"),
      password: env("EXECUTOR_ADMIN_PASSWORD"),
    })
  );
}
if (process.env.VAULT_URL) {
  const account = await ensureVaultAccount(process.env.VAULT_URL, env("VAULT_EMAIL"), env("VAULT_PASSWORD"));
  console.log(`vault account ${account}`);
}
const executorKey = executorUrl ? await executorToken(executorUrl) : undefined;

// Questions only the owner can answer (a task's write, using a card): texted, answered by their next yes or no.
let pendingApproval: ((yes: boolean) => void) | undefined;
function askOwner(question: string) {
  if (!ownerSpace) return Promise.resolve(false);
  void ownerSpace.send(question);
  return new Promise<boolean>((resolve) => {
    pendingApproval = resolve;
    setTimeout(() => resolve(false), 10 * 60_000);
  });
}

const agent = await createAgent({
  db,
  dir,
  model: process.env.MODEL,
  tools: [
    ...memoryTools(db, env("EMBEDDINGS_URL")),
    ...(process.env.VAULT_URL
      ? vaultTools({ url: process.env.VAULT_URL, email: env("VAULT_EMAIL"), password: env("VAULT_PASSWORD"), dir, askOwner })
      : []),
    ...(process.env.VM_DIR
      ? [
          taskTool(process.env.VM_DIR, env("FIRECRACKER"), (goal, { report, screenshot }) =>
            deliver(`Task report (${goal}):\n${report}`, screenshot),
          ),
        ]
      : []),
  ],
  extensions: connectors({
    executor: executorUrl && executorKey ? { url: executorUrl, token: executorKey } : undefined,
    exaKey: process.env.EXA_API_KEY,
  }),
});

if (executorUrl && executorKey && process.env.PASSTHROUGH_PORT)
  startPassThrough({ executorUrl, token: executorKey, port: Number(process.env.PASSTHROUGH_PORT), askOwner });

// The owner's conversation, where replies to task reports go.
let ownerSpace: Space | undefined;
async function deliver(text: string, screenshot?: Buffer) {
  try {
    const reply = await agent.reply(text);
    if (reply && ownerSpace) await ownerSpace.send(reply);
    if (screenshot && ownerSpace) await ownerSpace.send(attachment(screenshot, { mimeType: "image/png", name: "screen.png" }));
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
  // A yes or no while a task's write waits for approval answers that, not the conversation.
  if (pendingApproval && (YES.test(text.trim()) || NO.test(text.trim()))) {
    const yes = YES.test(text.trim());
    pendingApproval(yes);
    pendingApproval = undefined;
    await space.send(yes ? "Approved." : "Declined.");
    continue;
  }
  // Not awaited: a text that arrives mid-reply steers the reply already underway.
  space
    .responding(async () => {
      const reply = await agent.reply(text);
      if (reply) await space.send(reply);
    })
    .catch((err) => console.error(err));
}
