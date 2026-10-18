import { createCipheriv, createHmac, generateKeyPairSync, pbkdf2Sync, randomBytes } from "node:crypto";

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
