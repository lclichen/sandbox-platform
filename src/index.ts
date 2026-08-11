/**
 * HTTP server entry point.
 *
 * Runs migrations on startup (idempotent), then listens on HOST:PORT.
 */
import { createApp } from "./app.ts";
import { closeDatabase } from "./db/driver.ts";
import { runMigrations } from "./db/migrate.ts";
import { getExecutor } from "./executors/index.ts";
import { createReaper } from "./scheduler/reaper.ts";
import { logger } from "./utils/logger.ts";
import { loadConfig, assertSecureProductionConfig } from "./config.ts";

async function main() {
  const config = loadConfig();

  // Process-level error capture: surface unhandled rejections / exceptions in
  // the structured log before the process exits (Node's default is to exit on
  // unhandledRejection since v15, but without a handler the diagnostic is lost).
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.stack : String(reason) }, "Unhandled promise rejection.");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err: err.stack ?? err.message }, "Uncaught exception; exiting.");
    process.exit(1);
  });

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

  // Idle-container reaper: periodic auto-release of long-idle containers.
  const reaper = config.reaper.enabled ? createReaper(db, await getExecutor()) : undefined;
  reaper?.start();

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, "Server listening.");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    reaper?.stop();
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
