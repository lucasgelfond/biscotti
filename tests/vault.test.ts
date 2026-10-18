import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ensureVaultAccount } from "../agent/src/vault.ts";

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
