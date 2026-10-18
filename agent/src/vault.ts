import { defineTool } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  pbkdf2Sync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { promisify } from "node:util";
import { Type } from "typebox";

// The agent's own Vaultwarden account, which the owner shares items with through an organization. Bitwarden's CLI
// reads it, but no official tool registers accounts, and Bitwarden clients do the encryption, so registering follows
// the client's steps.

const KDF_ITERATIONS = 600_000;

// HKDF-Expand alone (no extract step), one 32-byte block, as Bitwarden stretches the master key.
const expand = (key: Buffer, info: string) =>
  createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();

function masterKeys(email: string, password: string) {
  const masterKey = pbkdf2Sync(password, email.toLowerCase(), KDF_ITERATIONS, 32, "sha256");
  return {
    hash: pbkdf2Sync(masterKey, password, 1, 32, "sha256").toString("base64"),
    stretched: Buffer.concat([expand(masterKey, "enc"), expand(masterKey, "mac")]),
  };
}

// Bitwarden's "type 2" encrypted string: AES-256-CBC with an HMAC-SHA256 over iv and ciphertext. Keys are 64 bytes:
// 32 for encryption, then 32 for the MAC.
function encrypt(plain: Buffer, key: Buffer) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, data]))
    .digest();
  return `2.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
}

function decrypt(enc: string, key: Buffer) {
  const [iv, data, mac] = enc.slice(2).split("|").map((p) => Buffer.from(p, "base64"));
  const expected = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, data])).digest();
  if (!expected.equals(mac)) throw new Error("vault: bad MAC");
  const decipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Bitwarden's "type 4" encrypted string: RSA-OAEP (SHA-1), used to hand an organization key to a member.
const rsaOpts = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" };
const rsaEncrypt = (data: Buffer, key: KeyObject) => `4.${publicEncrypt({ key, ...rsaOpts }, data).toString("base64")}`;
const rsaDecrypt = (enc: string, key: KeyObject) => privateDecrypt({ key, ...rsaOpts }, Buffer.from(enc.slice(2), "base64"));

// Registers the account if it doesn't exist yet, with an RSA key pair so organizations can share items with it.
export async function ensureVaultAccount(url: string, email: string, password: string) {
  const { hash, stretched } = masterKeys(email, password);
  const vaultKey = randomBytes(64);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const post = (path: string, body: object) =>
    fetch(`${url}/identity/accounts/register/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // With no mail server, Vaultwarden returns the verification token instead of emailing it.
  const verification = await post("send-verification-email", { email, name: "biscotti" });
  const token = await verification.text();
  if (!verification.ok) return accountExists(verification.status, token);

  const res = await post("finish", {
    email,
    emailVerificationToken: token,
    masterPasswordHash: hash,
    key: encrypt(vaultKey, stretched),
    kdf: 0,
    kdfIterations: KDF_ITERATIONS,
    keys: {
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      encryptedPrivateKey: encrypt(privateKey.export({ type: "pkcs8", format: "der" }), vaultKey),
    },
  });
  return res.ok ? "created" : accountExists(res.status, await res.text());
}

function accountExists(status: number, body: string) {
  if (/already exists/i.test(body)) return "exists";
  throw new Error(`vaultwarden register: ${status} ${body}`);
}

// Sharing: the agent's account owns a "biscotti" organization with a "Shared" collection, invites the owner, and
// confirms them once they've registered (confirming hands them the organization key, encrypted to their public key).
// Safe to repeat. Returns where things stand; "owner-managed" means the owner set sharing up themselves.
export async function ensureVaultSharing(url: string, email: string, password: string, ownerEmail: string) {
  const { hash, stretched } = masterKeys(email, password);
  const token = await fetch(`${url}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      username: email,
      password: hash,
      scope: "api offline_access",
      client_id: "cli",
      deviceType: "8",
      deviceIdentifier: randomUUID(),
      deviceName: "biscotti",
    }),
  }).then((r) => r.json() as Promise<{ access_token: string; Key: string; PrivateKey: string }>);
  const api = async (path: string, body?: object) => {
    const res = await fetch(`${url}/api${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`vaultwarden ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const privateKey = createPrivateKey({ key: decrypt(token.PrivateKey, decrypt(token.Key, stretched)), format: "der", type: "pkcs8" });

  const { profile } = await api("/sync?excludeDomains=true");
  const existing = profile.organizations.find((o: { name: string }) => o.name.toLowerCase() === "biscotti");
  if (existing && existing.type !== 0) return "owner-managed";

  let org = existing;
  if (!org) {
    const orgKey = randomBytes(64);
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    org = await api("/organizations", {
      name: "biscotti",
      billingEmail: email,
      collectionName: encrypt(Buffer.from("Shared"), orgKey),
      key: rsaEncrypt(orgKey, createPublicKey(privateKey)),
      keys: {
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        encryptedPrivateKey: encrypt(keys.privateKey.export({ type: "pkcs8", format: "der" }), orgKey),
      },
      planType: 0,
    });
    org.key = rsaEncrypt(orgKey, createPublicKey(privateKey));
  }
  const orgKey = rsaDecrypt(org.key, privateKey);

  const members: { id: string; userId: string; email: string; status: number }[] = (await api(`/organizations/${org.id}/users`)).data;
  const owner = members.find((m) => m.email.toLowerCase() === ownerEmail.toLowerCase());
  if (!owner) {
    const [shared] = (await api(`/organizations/${org.id}/collections`)).data;
    await api(`/organizations/${org.id}/users/invite`, {
      emails: [ownerEmail],
      groups: [],
      type: 2,
      collections: [{ id: shared.id, readOnly: false, hidePasswords: false, manage: true }],
      permissions: {},
    });
    return "invited";
  }
  if (owner.status === 0) return "invited";
  if (owner.status === 1) {
    const { publicKey } = await api(`/users/${owner.userId}/public-key`);
    const ownerKey = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    await api(`/organizations/${org.id}/users/${owner.id}/confirm`, { key: rsaEncrypt(orgKey, ownerKey) });
  }
  return "confirmed";
}

// Reading the vault: Bitwarden's CLI, logged in as the agent's account.

const BW = new URL("../node_modules/.bin/bw", import.meta.url).pathname;
const run = promisify(execFile);

interface Item {
  id: string;
  name: string;
  notes: string | null;
  login?: { username: string | null; password: string | null; totp: string | null; uris?: { uri: string }[] | null } | null;
  card?: Record<string, string | null> | null;
  identity?: Record<string, string | null> | null;
  fields?: { name: string; value: string | null }[] | null;
}

// An item's values by field name: "username", "password", "totp", "url", "card.number", "identity.licenseNumber", …
function fieldsOf(item: Item): Record<string, string> {
  const fields: Record<string, string | null | undefined> = {
    username: item.login?.username,
    password: item.login?.password,
    totp: item.login?.totp,
    url: item.login?.uris?.[0]?.uri,
    notes: item.notes,
    ...Object.fromEntries(Object.entries(item.card ?? {}).map(([k, v]) => [`card.${k}`, v])),
    ...Object.fromEntries(Object.entries(item.identity ?? {}).map(([k, v]) => [`identity.${k}`, v])),
    ...Object.fromEntries((item.fields ?? []).map((f) => [f.name, f.value])),
  };
  return Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export function vaultTools(opts: {
  url: string;
  email: string;
  password: string;
  dir: string;
  askOwner: (question: string) => Promise<boolean>;
}) {
  const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: `${opts.dir}/bw` };
  const bw = async (...args: string[]) => (await run(BW, args, { env })).stdout.trim();
  let session: string | undefined;

  async function items(): Promise<Item[]> {
    if (!session) {
      const { status } = JSON.parse(await bw("status"));
      if (status === "unauthenticated") {
        await bw("config", "server", opts.url);
        session = await bw("login", opts.email, opts.password, "--raw");
      } else session = await bw("unlock", opts.password, "--raw");
    }
    await bw("sync", "--session", session);
    return JSON.parse(await bw("list", "items", "--session", session));
  }

  const list = defineTool({
    name: "vault_list",
    label: "Vault",
    description: "List the items the owner shared to your vault and which fields each has (no values).",
    parameters: Type.Object({}),
    async execute() {
      const lines = (await items()).map((i) => `${i.name}: ${Object.keys(fieldsOf(i)).join(", ")}`);
      return text(lines.length ? lines.join("\n") : "The vault is empty; ask the owner to share items to the biscotti organization.");
    },
  });

  const get = defineTool({
    name: "vault_get",
    label: "Vault",
    description:
      "Read one field of a vault item, e.g. a password to log in or an address to fill a form. Card fields ask the owner first. For 'totp' this returns the current 2FA code.",
    parameters: Type.Object({ item: Type.String({ description: "The item's name, as vault_list shows it." }), field: Type.String() }),
    async execute(_id, { item, field }) {
      const match = (await items()).find((i) => i.name.toLowerCase() === item.toLowerCase());
      if (!match) return text(`No vault item named "${item}".`);
      const value = fieldsOf(match)[field];
      if (value === undefined) return text(`"${match.name}" has no field "${field}".`);
      if (field.startsWith("card.") && !(await opts.askOwner(`Use your card "${match.name}" (${field})? Reply yes or no.`)))
        return text("The owner said no.");
      return text(field === "totp" ? await bw("get", "totp", match.id, "--session", session!) : value);
    },
  });

  return [list, get];
}
