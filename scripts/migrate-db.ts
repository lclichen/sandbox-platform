/**
 * Cross-database migration CLI: copy all application data from a source
 * database into a target database (sqlite <-> postgresql in either direction).
 *
 * Implemented as a backup of the source + restore into the target, using the
 * portable JSON archive format. The target's schema is ensured via runMigrations.
 *
 * Usage:
 *   npm run migrate-db -- \
 *     --from sqlite:./data/sandbox.db \
 *     --to "postgresql://user:pass@host:5432/sandbox"
 *
 * The --from / --to value format is "<dialect>:<location>" where location is
 * a filesystem path for sqlite or a connection URL for postgresql.
 */
import { createDatabase, closeDatabase } from "../src/db/driver.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { logger } from "../src/utils/logger.ts";
import { buildArchive, type BackupArchive } from "./backup.ts";
import { loadInto } from "./restore.ts";

interface EndpointSpec {
  dialect: "sqlite" | "postgresql";
  location: string;
}

export function parseEndpoint(spec: string): EndpointSpec {
  const idx = spec.indexOf(":");
  if (idx < 0) throw new Error(`Invalid endpoint spec: ${spec}. Expected "<dialect>:<location>".`);
  const dialect = spec.slice(0, idx) as EndpointSpec["dialect"];
  const location = spec.slice(idx + 1);
  if (dialect !== "sqlite" && dialect !== "postgresql") {
    throw new Error(`Unsupported dialect: ${dialect}`);
  }
  return { dialect, location };
}

async function openDb(spec: EndpointSpec) {
  if (spec.dialect === "sqlite") return createDatabase({ dialect: "sqlite", sqlitePath: spec.location });
  return createDatabase({ dialect: "postgresql", postgresUrl: spec.location });
}

/** Migrate data from source to target (usable from tests). */
export async function migrateData(from: EndpointSpec, to: EndpointSpec): Promise<BackupArchive> {
  // Close any cached app singleton so source/target DBs open fresh.
  await closeDatabase();
  const sourceDb = await openDb(from);
  let archive: BackupArchive;
  try {
    archive = await buildArchive(sourceDb);
  } finally {
    await sourceDb.close();
  }
  const total = Object.values(archive.tables).reduce((a, r) => a + r.length, 0);
  logger.info({ sourceDialect: archive.sourceDialect, totalRows: total }, "Source archive built.");

  const targetDb = await openDb(to);
  try {
    await runMigrations(targetDb);
    await loadInto(targetDb, archive);
  } finally {
    await targetDb.close();
  }
  return archive;
}

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  if (fromIdx < 0 || toIdx < 0) {
    logger.error("Usage: migrate-db --from <dialect>:<location> --to <dialect>:<location>");
    process.exit(1);
  }
  const from = parseEndpoint(args[fromIdx + 1]);
  const to = parseEndpoint(args[toIdx + 1]);

  logger.info({ from, to }, "Starting cross-database migration.");
  await migrateData(from, to);
  logger.info({ from: from.dialect, to: to.dialect }, "Migration complete.");
}

// Only run the CLI when invoked directly, not when imported (e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate-db.ts")) {
  main().catch((error) => {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Migration failed.");
    process.exit(1);
  });
}
