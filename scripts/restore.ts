/**
 * Restore CLI: load a JSON backup archive into the configured database.
 *
 * The target database must already have its schema (run `npm run migrate`
 * first). Restore truncates application tables, then inserts rows in
 * dependency order inside a transaction. SQLite-style autoincrement sequences
 * are reset to the max id seen so subsequent inserts do not collide.
 *
 * Usage:
 *   npm run restore -- --in backups/backup-2026-...json
 *
 * Env: DB_DIALECT, DB_SQLITE_PATH, DATABASE_URL (target database).
 */
import { readFileSync } from "node:fs";
import { createDatabase, closeDatabase, encodeJson, type Database } from "../src/db/driver.ts";
import { logger } from "../src/utils/logger.ts";
import { TABLES, type BackupArchive } from "./backup.ts";

// JSON columns must be re-encoded for the target dialect on load.
export const JSON_COLUMNS: Record<string, string[]> = {
  images: ["tags", "default_resources"],
  containers: ["env"],
  operation_logs: ["detail"],
};

async function insertRows(db: Database, table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const jsonCols = new Set(JSON_COLUMNS[table] ?? []);
  for (const row of rows) {
    const cols = Object.keys(row);
    const values = cols.map((c) => {
      const v = row[c];
      if (jsonCols.has(c)) return encodeJson(v ?? null, db.dialect);
      return v ?? null;
    });
    const placeholders = cols.map(() => "?").join(", ");
    await db.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
      ...(values as Parameters<Database["run"]>),
    );
  }
}

async function resetSequences(db: Database): Promise<void> {
  if (db.dialect !== "sqlite") return;
  // sqlite_sequence's `name` column is not declared UNIQUE, so ON CONFLICT
  // won't work. Delete-then-insert per table instead.
  for (const table of TABLES) {
    const max = await db.get<{ m: number }>(`SELECT MAX(id) AS m FROM ${table}`);
    const next = (Number(max?.m ?? 0)) + 1;
    await db.run("DELETE FROM sqlite_sequence WHERE name = ?", table);
    await db.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", table, next);
  }
}

/** Truncate + load an archive into a target database (schema must exist). */
export async function loadInto(db: Database, archive: BackupArchive): Promise<void> {
  await db.tx(async (tx) => {
    for (const table of [...TABLES].reverse()) {
      await tx.run(`DELETE FROM ${table}`);
    }
    for (const table of TABLES) {
      await insertRows(tx as unknown as Database, table, archive.tables[table] ?? []);
      logger.info({ table, rows: archive.tables[table]?.length ?? 0 }, "restored");
    }
  });
  await resetSequences(db);
}

async function main() {
  const args = process.argv.slice(2);
  const inIdx = args.indexOf("--in");
  const inArg = inIdx >= 0 ? args[inIdx + 1] : undefined;
  if (!inArg) {
    logger.error("Usage: restore --in <backup.json>");
    process.exit(1);
  }

  const raw = readFileSync(inArg, "utf8");
  const archive = JSON.parse(raw) as BackupArchive;
  if (archive.format !== "sandbox-platform-backup") {
    logger.error({ format: archive.format }, "Unknown backup format.");
    process.exit(1);
  }

  const db = await createDatabase();
  try {
    await loadInto(db, archive);
    logger.info({ from: archive.sourceDialect, to: db.dialect }, "Restore complete.");
  } finally {
    await closeDatabase();
  }
}

// Only run the CLI when invoked directly, not when imported (e.g. by tests).
if (process.argv[1]?.endsWith("restore.ts")) {
  main().catch((error) => {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Restore failed.");
    process.exit(1);
  });
}
