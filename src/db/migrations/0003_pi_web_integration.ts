/**
 * pi-web integration migration (PI-WEB-INTEGRATION-REQUIREMENTS R1/R6/R9).
 *
 *   users.must_change_password        — R9: admin-created / imported accounts
 *                                        force a password change on first login.
 *   resource_quotas.allowed_image_ids — R6: per-quota image whitelist
 *                                        (NULL/empty = all public images).
 */
import type { Migration } from "../migrate.ts";

export const up: Migration["up"] = async ({ db }) => {
  if (db.dialect === "sqlite") {
    await db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
    await db.exec("ALTER TABLE resource_quotas ADD COLUMN allowed_image_ids TEXT");
  } else {
    await db.exec("ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE");
    await db.exec("ALTER TABLE resource_quotas ADD COLUMN allowed_image_ids JSONB");
  }
};

export const down: Migration["down"] = async ({ db }) => {
  await db.exec("ALTER TABLE users DROP COLUMN must_change_password");
  await db.exec("ALTER TABLE resource_quotas DROP COLUMN allowed_image_ids");
};
