/**
 * Reset a user's password directly against the database (recovery tool).
 *
 * Use case: admin lockout. SEED_ADMIN_* only bootstraps an EMPTY database —
 * changing the env vars does nothing on an existing install, and without a
 * second admin there is no API path back in. This script goes straight to
 * the database with the same semantics as the admin API's password reset:
 * bcrypt hash, token_version bump (every outstanding access token dies),
 * refresh tokens revoked, and optionally the must_change_password flag set
 * so the account picks a fresh password at next login.
 *
 * Usage:
 *   npm run reset-admin-password -- --user admin --password 'NewStrongPass1' [--must-change] // secret-scan:allow (usage example)
 *   # or via env:
 *   RESET_USER=admin RESET_PASSWORD='NewStrongPass1' npm run reset-admin-password // secret-scan:allow (usage example)
 *
 * Env (DB connection): DB_DIALECT, DB_SQLITE_PATH, DATABASE_URL — same as
 * the platform process (read .env via the platform's config loading? No:
 * run it with the same environment as `npm run start`, e.g. from start-all's
 * generated platform.env: `set -a; . config/platform.env; set +a;
 * npm run reset-admin-password -- --user admin --password '...'`).
 */
import { createDatabase, closeDatabase } from "../src/db/driver.ts";
import { createUserService } from "../src/services/user.service.ts";
import { validatePasswordPolicy } from "../src/auth/password.ts";
import { logger } from "../src/utils/logger.ts";

interface Args {
  user: string;
  password: string;
  mustChange: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const user = get("user") ?? process.env.RESET_USER;
  const password = get("password") ?? process.env.RESET_PASSWORD;
  const mustChange = argv.includes("--must-change");
  if (!user) throw new Error("--user <username> (or RESET_USER) is required.");
  if (!password) throw new Error("--password <new-password> (or RESET_PASSWORD) is required.");
  return { user, password, mustChange };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const violation = validatePasswordPolicy(args.password);
  if (violation) {
    throw new Error(`Password policy violation: ${violation}`);
  }
  const db = await createDatabase();
  try {
    const users = createUserService(db);
    const row = await users.getByUsername(args.user);
    if (!row) {
      throw new Error(`User '${args.user}' not found.`);
    }
    if (row.role !== "admin") {
      logger.warn(
        { username: row.username, role: row.role },
        "Note: this account is not an admin — resetting it anyway as requested.",
      );
    }
    // Same semantics as the admin API: hash + token_version bump, then revoke
    // outstanding refresh tokens (setPassword clears must_change when told to;
    // we force the flag AFTERWARDS instead when --must-change is requested).
    await users.setPassword(row.id, args.password);
    await db.run(
      "UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL",
      row.id,
    );
    if (args.mustChange) {
      await db.run("UPDATE users SET must_change_password = 1 WHERE id = ?", row.id);
    }
    logger.info(
      { username: row.username, id: row.id, mustChange: args.mustChange },
      `Password reset for '${row.username}'. All their sessions and API-key access tokens are now invalid; ` +
        `existing API keys still work (revoke them from the admin UI if the account was compromised).`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, "reset-admin-password failed");
  process.exit(1);
});
