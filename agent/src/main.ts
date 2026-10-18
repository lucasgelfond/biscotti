import { defineTool } from "@earendil-works/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { attachment, type Space } from "@spectrum-ts/core";
import { Type } from "typebox";
import { createAgent } from "./agent.ts";
import { connectIMessage } from "./imessage.ts";
import { connectors, ensureExecutorToken, NO, YES } from "./connectors.ts";
import { openDb } from "./db.ts";
import { memoryTools } from "./memory.ts";
import { pageTool } from "./pages.ts";
import { startGate } from "./gate.ts";
import { taskTool } from "./sandbox.ts";
import { ensureVaultAccount, ensureVaultSharing, vaultTools } from "./vault.ts";
import { startWakes, wakeTools } from "./wakes.ts";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const dir = process.env.DATA_DIR ?? "/data";
const db = openDb(`${dir}/biscotti.db`);
const executorUrl = process.env.EXECUTOR_URL;
const timezone = process.env.TZ ?? "America/New_York";

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

// The owner's conversation, where replies to task reports go, and their latest message (for tapbacks).
let ownerSpace: Space | undefined;
let lastMessage: { react: (emoji: string) => Promise<unknown> } | undefined;
const reactTool = defineTool({
  name: "react",
  label: "Tapback",
  description: "Tapback the user's latest message (❤️ 👍 👎 😂 ‼️ ❓), e.g. 👍 when starting on something, ❤️ on thanks. Can replace a reply.",
  parameters: Type.Object({ emoji: Type.String() }),
  async execute(_id, { emoji }) {
    await lastMessage?.react(emoji);
    return { content: [{ type: "text" as const, text: "Reacted." }], details: {} };
  },
});

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

const vault = process.env.VAULT_URL
  ? vaultTools({ url: process.env.VAULT_URL, email: env("VAULT_EMAIL"), password: env("VAULT_PASSWORD"), dir, askOwner })
  : [];

const agent = await createAgent({
  db,
  dir,
  model: process.env.MODEL,
  tools: [
    ...memoryTools(db, env("EMBEDDINGS_URL")),
    ...wakeTools(db, timezone),
    reactTool,
    ...(process.env.PAGES_URL ? [pageTool(`${dir}/pages`, process.env.PAGES_URL)] : []),
    ...vault,
    ...(process.env.VM_DIR
      ? [
          taskTool(
            process.env.VM_DIR,
            env("FIRECRACKER"),
            (goal, { report, screenshot }) => deliver(`Task report (${goal}):\n${report}`, screenshot),
            (_, slot) =>
              process.env.LIVE_DESKTOP_URL &&
              void ownerSpace?.send(`Working on it. Watch or take over: ${process.env.LIVE_DESKTOP_URL}:${10440 + slot}/vnc.html`),
          ),
        ]
      : []),
  ],
  extensions: connectors({
    executor: executorUrl && executorKey ? { url: executorUrl, token: executorKey } : undefined,
    exaKey: process.env.EXA_API_KEY,
  }),
});

if (executorUrl && executorKey && process.env.GATE_PORT)
  startGate({
    executorUrl,
    token: executorKey,
    gatewayKey: env("AI_GATEWAY_API_KEY"),
    taskModel: process.env.TASK_MODEL ?? "deepseek/deepseek-v4.1-flash-1017-fast",
    exaKey: process.env.EXA_API_KEY,
    hostTools: vault,
    port: Number(process.env.GATE_PORT),
    askOwner,
  });

// Sends a reply, with any page links as messages of their own so iMessage expands them into cards.
async function sendReply(reply: string) {
  const pages = process.env.PAGES_URL;
  const links = pages ? reply.split(/\s+/).filter((word) => word.startsWith(`${pages}/`)) : [];
  const text = links.reduce((t, link) => t.replace(link, ""), reply).trim();
  if (text) await ownerSpace?.send(text);
  for (const link of links) await ownerSpace?.send(link);
}

async function deliver(text: string, screenshot?: Buffer) {
  try {
    const reply = await agent.reply(text);
    if (reply) await sendReply(reply);
    if (screenshot && ownerSpace) await ownerSpace.send(attachment(screenshot, { mimeType: "image/png", name: "screen.png" }));
  } catch (err) {
    console.error(err);
  }
}

const owner = env("OWNER");
const imessage = await connectIMessage(env);
ownerSpace = imessage.ownerSpace;
startWakes(db, timezone, (wake) => deliver(`Wake (${wake.label}): ${wake.prompt}`));

// Vault sharing on a fresh install: invite the owner, tell them once where to sign up, confirm them once they have.
if (process.env.VAULT_URL && process.env.OWNER_EMAIL) {
  const [url, email, password, ownerEmail] = [process.env.VAULT_URL, env("VAULT_EMAIL"), env("VAULT_PASSWORD"), process.env.OWNER_EMAIL];
  const toldFile = `${dir}/vault-invite-sent`;
  const check = async () => {
    const state = await ensureVaultSharing(url, email, password, ownerEmail).catch((err) => (console.error(err), "error"));
    if (state === "invited" && !existsSync(toldFile)) {
      await ownerSpace?.send(
        `Your vault is ready for you: create your account at ${url} with ${ownerEmail}. Anything you put in the biscotti organization's Shared collection, I can use.`,
      );
      writeFileSync(toldFile, "");
    }
    if (state === "invited" || state === "error") setTimeout(check, 2 * 60_000);
  };
  void check();
}

for await (const [space, message] of imessage.app.messages) {
  if (message.direction === "outbound" || message.content.type !== "text") continue;
  if (message.sender?.id !== owner) {
    console.warn(`ignoring message from ${message.sender?.id}`);
    continue;
  }
  ownerSpace = space;
  lastMessage = message;
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
      if (reply) await sendReply(reply);
    })
    .catch((err) => console.error(err));
}
