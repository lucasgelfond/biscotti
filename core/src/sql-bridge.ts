import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { openEncrypted } from "./memory.ts";

// pi-durable's storage in the gate's encrypted database, for the agent, which holds no key: each statement crosses the
// agent's socket and runs here, on a connection of its own, one transaction at a time.

type Op = "exec" | "run" | "runCounted" | "get" | "all" | "begin" | "commit" | "rollback";
export interface SqlRequest {
  op: Op;
  sql?: string;
  params?: unknown[];
  tx?: string;
}

// Values as JSON: bigints and byte arrays tagged, so they come back as they went.
const encode = (v: unknown): unknown =>
  typeof v === "bigint" ? { $n: v.toString() } : v instanceof Uint8Array ? { $b: Buffer.from(v).toString("base64") } : v;
const decode = (v: unknown): unknown => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const tagged = v as { $n?: string; $b?: string };
    if (typeof tagged.$n === "string") return BigInt(tagged.$n);
    if (typeof tagged.$b === "string") return new Uint8Array(Buffer.from(tagged.$b, "base64"));
  }
  return v;
};
const mapRow = (code: (v: unknown) => unknown) => (row: unknown) => (row && typeof row === "object" ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, code(v)])) : row);
const encodeRow = mapRow(encode);
const decodeRow = mapRow(decode);
export const encodeParams = (params: SqliteValue[]) => params.map(encode);

// The gate's side. A transaction the agent leaves open (it died, or lost the socket) is rolled back after `idleMs`.
// TODO: over one upgraded socket (as /env is), so a transaction lasts as long as the connection: no request per
// statement and no idle rollback.
export function sqlBridge(path: string, key: string, idleMs = 30_000) {
  const db = openEncrypted(path, key);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const statements = new Map<string, Database.Statement>();
  const prepare = (sql: string) => {
    let s = statements.get(sql);
    if (!s) statements.set(sql, (s = db.prepare(sql)));
    return s;
  };
  let open: { id: string; timer?: NodeJS.Timeout } | undefined;
  let waiting: (() => void)[] = [];
  const end = (how: "COMMIT" | "ROLLBACK") => {
    clearTimeout(open!.timer);
    open = undefined;
    try {
      db.exec(how);
    } finally {
      const go = waiting;
      waiting = [];
      for (const w of go) w();
    }
  };
  const arm = () => {
    clearTimeout(open!.timer);
    open!.timer = setTimeout(() => open && end("ROLLBACK"), idleMs).unref();
  };
  const idle = async () => {
    while (open) await new Promise<void>((r) => waiting.push(r));
  };

  function statement(op: Op, sql: string, params: unknown[]) {
    const values = params.map(decode);
    if (op === "exec") return void db.exec(sql);
    const s = prepare(sql);
    if (op === "run") return void s.run(...values);
    if (op === "runCounted") return s.run(...values).changes;
    if (op === "get") return s.reader ? encodeRow(s.get(...values)) : (s.run(...values), undefined);
    return s.reader ? s.all(...values).map(encodeRow) : (s.run(...values), []);
  }

  return {
    async handle(req: SqlRequest): Promise<unknown> {
      if (req.op === "begin") {
        await idle();
        db.exec("BEGIN IMMEDIATE");
        open = { id: randomUUID() };
        arm();
        return { tx: open.id };
      }
      if (req.tx !== undefined) {
        if (req.tx !== open?.id) throw new Error("that transaction isn't open (it was rolled back after going idle)");
        if (req.op === "commit") return void end("COMMIT");
        if (req.op === "rollback") return void end("ROLLBACK");
        arm();
        return statement(req.op, req.sql!, req.params ?? []);
      }
      await idle();
      return statement(req.op, req.sql!, req.params ?? []);
    },
    close: () => db.close(),
  };
}

// The agent's side: pi-durable's SqliteDatabase over `post` (the gate's /sql). Operations go one at a time, and a
// transaction holds the line until it ends, as the interface asks.
export class RemoteSqliteDatabase implements SqliteDatabase {
  #line: Promise<unknown> = Promise.resolve();
  readonly post: (req: SqlRequest) => Promise<unknown>;
  constructor(post: (req: SqlRequest) => Promise<unknown>) {
    this.post = post;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#line.then(fn);
    this.#line = next.catch(() => {});
    return next;
  }
  #executor(tx?: string): SqliteExecutor {
    const call = (op: Op, sql: string, params: SqliteValue[]) => this.post({ op, sql, params: encodeParams(params), ...(tx && { tx }) });
    return {
      exec: async (sql) => void (await call("exec", sql, [])),
      run: async (sql, ...params) => void (await call("run", sql, params)),
      runCounted: async (sql, ...params) => (await call("runCounted", sql, params)) as number,
      get: async <T extends object>(sql: string, ...params: SqliteValue[]) => decodeRow(await call("get", sql, params)) as T | undefined,
      all: async <T extends object>(sql: string, ...params: SqliteValue[]) => ((await call("all", sql, params)) as unknown[]).map(decodeRow) as T[],
    };
  }
  exec(sql: string) {
    return this.#serial(() => this.#executor().exec(sql));
  }
  run(sql: string, ...params: SqliteValue[]) {
    return this.#serial(() => this.#executor().run(sql, ...params));
  }
  runCounted(sql: string, ...params: SqliteValue[]) {
    return this.#serial(() => this.#executor().runCounted(sql, ...params));
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.#serial(() => this.#executor().get<T>(sql, ...params));
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.#serial(() => this.#executor().all<T>(sql, ...params));
  }
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      const { tx } = (await this.post({ op: "begin" })) as { tx: string };
      let result: T;
      try {
        result = await callback(this.#executor(tx));
      } catch (err) {
        try {
          await this.post({ op: "rollback", tx });
        } catch (rollbackError) {
          throw new AggregateError([err, rollbackError], "the transaction failed and couldn't be rolled back");
        }
        throw err;
      }
      await this.post({ op: "commit", tx });
      return result;
    });
  }
  async close() {}
}
