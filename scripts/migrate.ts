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
import { loadConfig, assertSecureProductionConfig } from "../src/config.ts";

async function main() {
  const args = process.argv.slice(2);
  const rollback = args.includes("--rollback") || args.includes("rollback");
  const db = await createDatabase();

  // Seeding (0002) uses SEED_ADMIN_PASSWORD; refuse to mint a default-credential
  // admin in production. (Rollback never seeds, so it is not gated.)
  if (!rollback) {
    const secretProblems = assertSecureProductionConfig(loadConfig());
    if (secretProblems.length > 0) {
      for (const problem of secretProblems) {
        logger.error({ problem }, "Insecure production configuration.");
      }
      logger.error("Refusing to run migrations in production with insecure secrets. Fix .env and retry.");
      process.exit(1);
    }
  }

  try {
    if (rollback) {
      // Destructive confirmation: the chain is squashed, so rolling back the
      // baseline literally DROPs every table (users, snapshots, audit logs).
      // Require an explicit --force plus a data check; suggest a backup first.
      const force = args.includes("--force");
      const users = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users").catch(() => undefined);
      const hasData = Number(users?.n ?? 0) > 0;
      if (!force) {
        logger.error(
          "migrate:rollback is DESTRUCTIVE (the squashed chain rolls back by dropping ALL tables). " +
            "Run `npm run backup` first, then re-run with --force to confirm.",
        );
        process.exit(1);
      }
      if (hasData) {
        logger.warn(
          { users: users?.n },
          "Rolling back with live data — tables will be dropped. Hope you took that backup.",
        );
      }
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
