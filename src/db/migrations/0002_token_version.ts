/**
 * 0002: users.token_version — instant access-token revocation (fix plan C5).
 *
 * Access tokens embed `tv` (the owner's token_version at issue time). Bumping
 * the column (password change/reset, account disable) invalidates every
 * outstanding access token on the next request, instead of waiting out the
 * 15-minute TTL. API-key auth already reloads the user row per request and is
 * unaffected.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  await db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
};

export const down: Migration["down"] = async ({ db }) => {
  // SQLite >= 3.35 and PostgreSQL both support DROP COLUMN.
  await db.exec("ALTER TABLE users DROP COLUMN token_version");
};
