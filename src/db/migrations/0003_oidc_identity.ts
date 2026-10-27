/**
 * 0003: OIDC identity columns on users.
 *
 * OIDC-provisioned accounts are matched by the IdP's `sub` claim — NOT by
 * username. Linking by username would let anyone who controls an IdP account
 * with a matching username take over a pre-existing local account, so the
 * mapping is a separate unique column instead. `auth_provider` is carried for
 * display/audit ("local" | "oidc"); partial unique index keeps the subject
 * unique across providers (one IdP per deployment) while local rows stay
 * NULL-many.
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  await db.exec("ALTER TABLE users ADD COLUMN auth_provider VARCHAR(16) NOT NULL DEFAULT 'local'");
  await db.exec("ALTER TABLE users ADD COLUMN oidc_subject VARCHAR(255)");
  await db.exec("CREATE UNIQUE INDEX idx_users_oidc_subject ON users(oidc_subject) WHERE oidc_subject IS NOT NULL");
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec("DROP INDEX IF EXISTS idx_users_oidc_subject");
  await db.exec("ALTER TABLE users DROP COLUMN oidc_subject");
  await db.exec("ALTER TABLE users DROP COLUMN auth_provider");
};
