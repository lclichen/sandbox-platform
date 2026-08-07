/**
 * Minimal portable database abstraction.
 *
 * Why not knex: knex's sqlite driver (better-sqlite3) requires a native build
 * that is unavailable on this win32 host (no C++ toolchain, no matching
 * prebuilt binary for Node 22). Rather than depend on a fragile native build,
 * we use Node's built-in `node:sqlite` (DatabaseSync) for sqlite and the pure
 * JS `pg` driver for postgresql, behind one small interface.
 *
 * The interface is intentionally tiny: parameterized run/all/get plus a
 * transaction helper. Higher-level repositories compose these primitives and
 * stay dialect-agnostic. Migrations are plain TS modules that call db.exec for
 * each DDL statement, branching on dialect where the two differ.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// Type-only import: erased at runtime, so the test runner never sees a
// `node:sqlite` runtime import to mis-resolve. The value comes from createRequire below.
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import pg from "pg";
import { loadConfig, type DbDialect } from "../config.ts";

// node:sqlite is experimental and some bundlers/test runners mishandle the
// `node:` scheme; resolve it through createRequire so the import is opaque to
// static analysis, while keeping full typing via the type-only import above.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface QueryResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface Transaction {
  /** Dialect in effect (mirrors Database.dialect) for DDL branching in migrations. */
  readonly dialect: DbDialect;
  /** Execute one or more statements (DDL or multi-statement). No params. */
  exec(sql: string): Promise<void>;
  /** Run a statement inside this transaction (no RETURNS). */
  run(sql: string, ...params: SqlValue[]): Promise<QueryResult>;
  /** Query rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  /** Query a single row or null. */
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | null>;
}

export interface Database {
  readonly dialect: DbDialect;
  /** Execute one or more statements (DDL or multi-statement). No params. */
  exec(sql: string): Promise<void>;
  /** Run a parameterized statement that does not return rows. */
  run(sql: string, ...params: SqlValue[]): Promise<QueryResult>;
  /** Query rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  /** Query a single row or null. */
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | null>;
  /** Run a callback inside a transaction. Commits on resolve, rolls back on throw. */
  tx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Close the underlying connection. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// sqlite implementation backed by node:sqlite (DatabaseSync)
// ---------------------------------------------------------------------------

class SqliteDatabase implements Database {
  readonly dialect: DbDialect = "sqlite";
  private readonly db: DatabaseSyncType;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  async exec(sql: string): Promise<void> {
    // node:sqlite DatabaseSync.exec runs multiple statements but must be sync.
    this.db.exec(sql);
  }

  async run(sql: string, ...params: SqlValue[]): Promise<QueryResult> {
    const stmt = this.db.prepare(sql);
    try {
      const r = stmt.run(...toSqliteParams(params));
      return {
        changes: Number(r.changes) || 0,
        lastInsertRowid:
          r.lastInsertRowid === undefined ? undefined : Number(r.lastInsertRowid),
      };
    } finally {
      // node:sqlite statements are finalized via finalize(); prepare returns a
      // reusable object we drop here. GC handles it.
      (stmt as { finalize?: () => void }).finalize?.();
    }
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      return stmt.all(...toSqliteParams(params)) as T[];
    } finally {
      (stmt as { finalize?: () => void }).finalize?.();
    }
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    try {
      return (stmt.get(...toSqliteParams(params)) as T) ?? null;
    } finally {
      (stmt as { finalize?: () => void }).finalize?.();
    }
  }

  async tx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN;");
    // node:sqlite is synchronous; emulate async tx by awaiting the fn.
    const txImpl: Transaction = {
      dialect: this.dialect,
      exec: (sql) => this.exec(sql),
      run: (sql, ...p) => this.run(sql, ...p),
      all: <T = Record<string, unknown>>(sql: string, ...p: SqlValue[]) => this.all<T>(sql, ...p),
      get: <T = Record<string, unknown>>(sql: string, ...p: SqlValue[]) => this.get<T>(sql, ...p),
    };
    try {
      const result = await fn(txImpl);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** node:sqlite only accepts a subset of JS values; coerce our SqlValue union. */
function toSqliteParams(params: SqlValue[]): Array<string | number | null | Uint8Array> {
  return params.map((p) => {
    if (typeof p === "bigint") return Number(p); // sqlite stores as integer
    if (typeof p === "boolean") return p ? 1 : 0; // sqlite has no boolean type
    if (p instanceof Uint8Array) return Buffer.from(p);
    return p;
  });
}

// ---------------------------------------------------------------------------
// postgresql implementation backed by pg
// ---------------------------------------------------------------------------

class PostgresDatabase implements Database {
  readonly dialect: DbDialect = "postgresql";
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  private mapParams(sql: string, params: SqlValue[]): { text: string; values: unknown[] } {
    // Our SQL uses "?" placeholders for portability. pg needs "$1..$n".
    let i = 0;
    const text = sql.replace(/\?/g, () => `$${++i}`);
    const values = params.map((p) => {
      if (typeof p === "bigint") return Number(p);
      if (p instanceof Uint8Array) return Buffer.from(p);
      return p;
    });
    return { text, values };
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement DDL: pg can run via a single simple query.
    const client = await this.pool.connect();
    try {
      await client.query({ text: sql });
    } finally {
      client.release();
    }
  }

  async run(sql: string, ...params: SqlValue[]): Promise<QueryResult> {
    const { text, values } = this.mapParams(sql, params);
    const client = await this.pool.connect();
    try {
      const r = await client.query(text, values);
      let lastInsertRowid: number | bigint | undefined;
      if (r.rows.length === 1 && r.rows[0]) {
        const row = r.rows[0] as Record<string, unknown>;
        // Detect RETURNING id (convention: first column named id).
        const idVal = row.id ?? row.last_insert_rowid;
        if (idVal !== undefined) lastInsertRowid = Number(idVal);
      }
      return { changes: r.rowCount ?? 0, lastInsertRowid };
    } finally {
      client.release();
    }
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    const { text, values } = this.mapParams(sql, params);
    const client = await this.pool.connect();
    try {
      const r = await client.query(text, values);
      return r.rows as T[];
    } finally {
      client.release();
    }
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | null> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txImpl: Transaction = {
        dialect: this.dialect,
        exec: async (sql) => {
          await client.query({ text: sql });
        },
        run: async (sql, ...p) => {
          const { text, values } = this.mapParams(sql, p);
          const r = await client.query(text, values);
          let lastInsertRowid: number | bigint | undefined;
          if (r.rows.length === 1 && r.rows[0]) {
            const row = r.rows[0] as Record<string, unknown>;
            const idVal = row.id ?? row.last_insert_rowid;
            if (idVal !== undefined) lastInsertRowid = Number(idVal);
          }
          return { changes: r.rowCount ?? 0, lastInsertRowid };
        },
        all: <T = Record<string, unknown>>(sql: string, ...p: SqlValue[]) => {
          const { text, values } = this.mapParams(sql, p);
          return client.query(text, values).then((r) => r.rows as T[]);
        },
        get: <T = Record<string, unknown>>(sql: string, ...p: SqlValue[]) => {
          const { text, values } = this.mapParams(sql, p);
          return client.query(text, values).then((r) => (r.rows[0] as T) ?? null);
        },
      };
      try {
        const result = await fn(txImpl);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: Database | undefined;

export interface DbOptions {
  dialect?: DbDialect;
  sqlitePath?: string;
  postgresUrl?: string;
}

export async function createDatabase(opts: DbOptions = {}): Promise<Database> {
  // Cached singleton for app runtime (not for ad-hoc tooling).
  if (!opts.dialect && !opts.sqlitePath && !opts.postgresUrl && cached) return cached;

  const config = loadConfig();
  const dialect = opts.dialect ?? config.db.dialect;

  let db: Database;
  if (dialect === "sqlite") {
    const filename = opts.sqlitePath ?? config.db.sqlitePath;
    await mkdir(dirname(filename), { recursive: true });
    db = new SqliteDatabase(filename);
  } else {
    const connection = opts.postgresUrl ?? config.db.postgresUrl;
    if (!connection) {
      throw new Error("DATABASE_URL is required when DB_DIALECT=postgresql");
    }
    db = new PostgresDatabase(connection);
  }

  if (!opts.dialect && !opts.sqlitePath && !opts.postgresUrl) cached = db;
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = undefined;
  }
}

// ---------------------------------------------------------------------------
// JSON helpers (sqlite stores as TEXT; pg has native jsonb)
// ---------------------------------------------------------------------------

/** Serialize a JS value for a JSON column. sqlite: stringify; pg: pass-through. */
export function encodeJson(value: unknown, dialect: DbDialect): unknown {
  if (value === undefined) return null;
  if (dialect === "sqlite") return JSON.stringify(value);
  return value;
}

/** Parse a JSON column value back to JS. sqlite: parse string; pg: pass-through. */
export function decodeJson<T = unknown>(value: unknown, dialect: DbDialect): T | null {
  if (value === null || value === undefined) return null;
  if (dialect === "sqlite" && typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
  return value as T;
}
