import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExecutorToken } from "../agent/src/connectors.ts";

// The fresh Executor from tests/compose.yaml. Its first-run setup works once per `pnpm services`, so test files share
// the token it mints (kept while it still works).
export const EXECUTOR_URL = "http://127.0.0.1:8095";
const TOKEN_FILE = join(tmpdir(), "biscotti-tests-executor-token");

export async function executorToken() {
  if (existsSync(TOKEN_FILE)) {
    const token = readFileSync(TOKEN_FILE, "utf8");
    const check = await fetch(`${EXECUTOR_URL}/api/context`, { headers: { Authorization: `Bearer ${token}` } });
    if (check.ok) return token;
  }
  const admin = { name: "Test Owner", email: `owner-${randomUUID()}@example.com`, password: randomBytes(18).toString("base64url") };
  const token = await ensureExecutorToken(EXECUTOR_URL, EXECUTOR_URL, join(tmpdir(), `executor-${randomUUID()}`), admin);
  writeFileSync(TOKEN_FILE, token);
  return token;
}
