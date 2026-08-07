/**
 * Migration CLI. Wraps the migration runner so the project has a single
 * `npm run migrate` entry point that honors DB_DIALECT.
 *
 * Usage:
 *   npm run migrate            # apply pending migrations
 *   npm run migrate:rollback   # roll back the last applied migration
 *
 * Migrations are idempotent and seed the default admin/quota/images on first run.
 */
import { createDatabase, closeDatabase } from "../src/db/driver.ts";
import { runMigrations, rollbackLast } from "../src/db/migrate.ts";
import { logger } from "../src/utils/logger.ts";

async function main() {
  const args = process.argv.slice(2);
  const rollback = args.includes("--rollback") || args.includes("rollback");
  const db = await createDatabase();

  try {
    if (rollback) {
      const rolled = await rollbackLast(db);
      if (rolled) logger.info({ migration: rolled }, "Rolled back migration.");
      else logger.info("No migrations to roll back.");
      return;
    }

    const applied = await runMigrations(db);
    if (applied.length === 0) {
      logger.info("Already up to date.");
    } else {
      logger.info({ count: applied.length, migrations: applied }, "Migrations applied.");
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Migration failed.");
  process.exit(1);
});
