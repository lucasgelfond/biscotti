import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { RemoteSqliteDatabase, sqlBridge, type SqlRequest } from "../core/src/sql-bridge.ts";

// pi-durable's storage, kept in an encrypted database on the gate's side of a socket: its own conformance suite, with
// every request and answer through JSON as they cross the agent's socket.
registerStorageConformance({ describe, expect, it }, "pi-durable storage over the gate's encrypted database", async (use) => {
  const bridge = sqlBridge(join(mkdtempSync(join(tmpdir(), "sql-bridge-")), "biscotti.db"), "test-key");
  const db = new RemoteSqliteDatabase(async (req) => {
    const answer = await bridge.handle(JSON.parse(JSON.stringify(req)) as SqlRequest);
    return (JSON.parse(JSON.stringify({ answer })) as { answer?: unknown }).answer;
  });
  try {
    await use(await SqliteStorage.open(db, { prefix: "pi_" }));
  } finally {
    bridge.close();
  }
});

describe("the gate's side of the bridge", () => {
  it("rolls back a transaction the agent left open, and refuses its later statements", async () => {
    const bridge = sqlBridge(join(mkdtempSync(join(tmpdir(), "sql-bridge-")), "biscotti.db"), "k", 50);
    await bridge.handle({ op: "exec", sql: "CREATE TABLE t (v TEXT)" });
    const { tx } = (await bridge.handle({ op: "begin" })) as { tx: string };
    await bridge.handle({ op: "run", sql: "INSERT INTO t VALUES (?)", params: ["lost"], tx });
    await new Promise((r) => setTimeout(r, 120));
    await expect(bridge.handle({ op: "commit", tx })).rejects.toThrow(/isn't open/);
    expect(await bridge.handle({ op: "all", sql: "SELECT v FROM t" })).toEqual([]);
    bridge.close();
  });
});
