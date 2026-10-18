import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ensureVaultAccount, ensureVaultSharing, vaultTools } from "../agent/src/vault.ts";

// The Vaultwarden from tests/compose.yaml: plain HTTP for our registration, and HTTPS through Caddy's local CA for
// Bitwarden's official CLI, which refuses anything else.
const VAULT_URL = "http://127.0.0.1:8093";
const VAULT_HTTPS_URL = "https://localhost:8094";
const CADDY_ROOT_CA = new URL(".caddy/caddy/pki/authorities/local/root.crt", import.meta.url).pathname;
const BW = new URL("node_modules/.bin/bw", import.meta.url).pathname;

test("registers the agent's vault account once, and Bitwarden's own CLI can use it", async () => {
  const email = `agent-${randomUUID()}@biscotti.local`;
  const password = randomBytes(24).toString("base64url");

  const first = await ensureVaultAccount(VAULT_URL, email, password);
  const second = await ensureVaultAccount(VAULT_URL, email, password);
  expect(first).toBe("created");
  expect(second).toBe("exists");

  const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: mkdtempSync(join(tmpdir(), "bw-")), NODE_EXTRA_CA_CERTS: CADDY_ROOT_CA };
  const bw = (...args: string[]) => execFileSync(BW, args, { env, encoding: "utf8" }).trim();
  bw("config", "server", VAULT_HTTPS_URL);
  const session = bw("login", email, password, "--raw");
  const status = JSON.parse(bw("status", "--session", session));
  expect(status.status).toBe("unlocked");

  // Writing and reading back an item proves the vault key round-trips through Bitwarden's own crypto.
  const template = JSON.parse(bw("get", "template", "item", "--session", session));
  const item = { ...template, name: "Example login", notes: null, login: { username: "lucas", password: "hunter2" } };
  bw("create", "item", Buffer.from(JSON.stringify(item)).toString("base64"), "--session", session);
  const saved = JSON.parse(bw("list", "items", "--session", session));
  expect(saved.map((i: { name: string }) => i.name)).toEqual(["Example login"]);
  expect(saved[0].login.password).toBe("hunter2");
});

test("vault tools list items without values, read fields, and ask the owner before a card", async () => {
  const email = `agent-${randomUUID()}@biscotti.local`;
  const password = randomBytes(24).toString("base64url");
  await ensureVaultAccount(VAULT_URL, email, password);
  const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: mkdtempSync(join(tmpdir(), "bw-")), NODE_EXTRA_CA_CERTS: CADDY_ROOT_CA };
  const bw = (...args: string[]) => execFileSync(BW, args, { env, encoding: "utf8" }).trim();
  bw("config", "server", VAULT_HTTPS_URL);
  const session = bw("login", email, password, "--raw");
  const create = (item: object) => bw("create", "item", Buffer.from(JSON.stringify(item)).toString("base64"), "--session", session);
  create({ type: 1, name: "Example login", login: { username: "lucas", password: "hunter2" } });
  create({ type: 3, name: "Example card", card: { cardholderName: "Lucas", number: "4111111111111111", expMonth: "12", expYear: "2030", code: "123" } });

  process.env.NODE_EXTRA_CA_CERTS = CADDY_ROOT_CA;
  const questions: string[] = [];
  const answers = [false, true];
  const askOwner = async (question: string) => (questions.push(question), answers.shift()!);
  const [vaultList, vaultGet] = vaultTools({ url: VAULT_HTTPS_URL, email, password, dir: mkdtempSync(join(tmpdir(), "vault-")), askOwner });
  const call = async (tool: typeof vaultList, params: object) =>
    ((await tool.execute("call", params as never, undefined, undefined, undefined as never)).content[0] as { text: string }).text;

  const listed = await call(vaultList, {});
  const password1 = await call(vaultGet, { item: "Example login", field: "password" });
  const refused = await call(vaultGet, { item: "Example card", field: "card.number" });
  const allowed = await call(vaultGet, { item: "Example card", field: "card.number" });

  expect(listed).toContain("Example login: username, password");
  expect(listed).toContain("Example card: card.cardholderName");
  expect(listed).not.toContain("hunter2");
  expect(listed).not.toContain("4111111111111111");
  expect(password1).toBe("hunter2");
  expect(refused).toBe("The owner said no.");
  expect(allowed).toBe("4111111111111111");
  expect(questions).toHaveLength(2);
});

test("sets up sharing: the agent's organization invites the owner, confirms them, and sees what they share", async () => {
  const agentEmail = `agent-${randomUUID()}@biscotti.local`;
  const ownerEmail = `owner-${randomUUID()}@example.com`;
  const agentPassword = randomBytes(24).toString("base64url");
  const ownerPassword = randomBytes(24).toString("base64url");
  await ensureVaultAccount(VAULT_URL, agentEmail, agentPassword);

  const invited = await ensureVaultSharing(VAULT_URL, agentEmail, agentPassword, ownerEmail);
  await ensureVaultAccount(VAULT_URL, ownerEmail, ownerPassword);
  const confirmed = await ensureVaultSharing(VAULT_URL, agentEmail, agentPassword, ownerEmail);
  const again = await ensureVaultSharing(VAULT_URL, agentEmail, agentPassword, ownerEmail);
  expect(invited).toBe("invited");
  expect(confirmed).toBe("confirmed");
  expect(again).toBe("confirmed");

  // The owner, in Bitwarden's own client, puts a login in the shared collection.
  const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: mkdtempSync(join(tmpdir(), "bw-")), NODE_EXTRA_CA_CERTS: CADDY_ROOT_CA };
  const bw = (...args: string[]) => execFileSync(BW, args, { env, encoding: "utf8" }).trim();
  bw("config", "server", VAULT_HTTPS_URL);
  const session = bw("login", ownerEmail, ownerPassword, "--raw");
  const [org] = JSON.parse(bw("list", "organizations", "--session", session));
  const [shared] = JSON.parse(bw("list", "org-collections", "--organizationid", org.id, "--session", session));
  const item = { type: 1, name: "Shared login", organizationId: org.id, collectionIds: [shared.id], login: { username: "lucas", password: "s3cret" } };
  bw("create", "item", Buffer.from(JSON.stringify(item)).toString("base64"), "--organizationid", org.id, "--session", session);
  expect(org.status).toBe(2);
  expect(shared.name).toBe("Shared");

  process.env.NODE_EXTRA_CA_CERTS = CADDY_ROOT_CA;
  const [vaultList] = vaultTools({ url: VAULT_HTTPS_URL, email: agentEmail, password: agentPassword, dir: mkdtempSync(join(tmpdir(), "vault-")), askOwner: async () => false });
  const listed = await vaultList.execute("call", {} as never, undefined, undefined, undefined as never);
  expect((listed.content[0] as { text: string }).text).toContain("Shared login: username, password");
});
