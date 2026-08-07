/**
 * HTTP server entry point.
 *
 * Runs migrations on startup (idempotent), then listens on HOST:PORT.
 */
import { createApp } from "./app.ts";
import { closeDatabase } from "./db/driver.ts";
import { runMigrations } from "./db/migrate.ts";
import { logger } from "./utils/logger.ts";
import { loadConfig, assertSecureProductionConfig } from "./config.ts";

async function main() {
  const config = loadConfig();

  // Fail fast in production when known-insecure secrets are left in place
  // (public signing key / default admin password = instant compromise).
  const secretProblems = assertSecureProductionConfig(config);
  if (secretProblems.length > 0) {
    for (const problem of secretProblems) {
      logger.error({ problem }, "Insecure production configuration.");
    }
    logger.error("Refusing to start in production with insecure secrets. Fix .env and retry.");
    process.exit(1);
  }

  logger.info({ dialect: config.db.dialect }, "Starting sandbox platform...");
  // Ensure schema is current before serving traffic.
  const { app, db } = await createApp();
  const applied = await runMigrations(db);
  if (applied.length > 0) logger.info({ applied }, "Migrations applied on startup.");

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "Server listening.");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    server.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Fatal startup error.");
  process.exit(1);
});
