/**
 * Rotate the LLM_ENCRYPTION_KEY used for LiteLLM virtual-key plaintext at rest.
 *
 * The encryption key cannot be changed naively once keys are stored: every
 * ciphertext in `llm_virtual_keys.encrypted_key` was sealed under the old key
 * and would become undecryptable. This script re-encrypts all rows in place:
 * for each row, decrypt with the old key, re-encrypt with the new key, UPDATE.
 *
 * Run it once after changing LLM_ENCRYPTION_KEY in .env, BEFORE restarting the
 * platform with the new key (otherwise new reveals will use the new key while
 * old rows stay sealed under the old one and fail to decrypt).
 *
 * Usage:
 *   npm run rotate-llm-key -- --old <64-hex> --new <64-hex>
 *   # or via env:
 *   LLM_OLD_KEY=<hex> LLM_NEW_KEY=<hex> npm run rotate-llm-key
 *   # --dry-run to preview without writing
 *
 * Env (DB connection): DB_DIALECT, DB_SQLITE_PATH, DATABASE_URL.
 */
import { createDatabase, closeDatabase } from "../src/db/driver.ts";
import { decrypt, encrypt, isValidKeyHex } from "../src/utils/crypto.ts";
import { logger } from "../src/utils/logger.ts";

interface Args {
  oldKey: string;
  newKey: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const oldKey = get("old") ?? process.env.LLM_OLD_KEY;
  const newKey = get("new") ?? process.env.LLM_NEW_KEY;
  const dryRun = argv.includes("--dry-run");
  if (!oldKey || !isValidKeyHex(oldKey)) {
    throw new Error("--old <64-hex> (or LLM_OLD_KEY) is required and must be 64 hex chars.");
  }
  if (!newKey || !isValidKeyHex(newKey)) {
    throw new Error("--new <64-hex> (or LLM_NEW_KEY) is required and must be 64 hex chars.");
  }
  if (oldKey === newKey) {
    throw new Error("Old and new keys are identical; nothing to rotate.");
  }
  return { oldKey, newKey, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await createDatabase();

  const rows = await db.all<{ id: number; encrypted_key: string; name: string; revoked_at: string | null }>(
    "SELECT id, encrypted_key, name, revoked_at FROM llm_virtual_keys",
  );

  if (rows.length === 0) {
    logger.info("No llm_virtual_keys rows; nothing to rotate.");
    await closeDatabase();
    return;
  }

  logger.info({ rows: rows.length, dryRun: args.dryRun }, "Rotating LLM virtual-key encryption.");
  let reencrypted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const plaintext = decrypt(row.encrypted_key, args.oldKey);
      const newCipher = encrypt(plaintext, args.newKey);
      if (args.dryRun) {
        logger.info({ id: row.id, name: row.name }, "DRY-RUN: would re-encrypt.");
      } else {
        await db.run("UPDATE llm_virtual_keys SET encrypted_key = ? WHERE id = ?", newCipher, row.id);
      }
      reencrypted += 1;
    } catch (err) {
      // A row that fails to decrypt under the old key is already orphaned
      // (wrong key, corruption, or already rotated). Report and skip rather
      // than aborting the whole rotation.
      failed += 1;
      logger.error({ id: row.id, name: row.name, err: (err as Error).message }, "Failed to re-encrypt row; skipping.");
    }
  }

  logger.info({ reencrypted, failed, dryRun: args.dryRun }, "Rotation complete.");
  if (failed > 0) {
    logger.warn(
      `${failed} row(s) could not be re-encrypted under the old key. They are likely already orphaned; revoke and re-issue those keys via the admin UI after restarting with the new key.`,
    );
  }
  if (!args.dryRun && failed === 0) {
    logger.info("All rows re-encrypted. Update LLM_ENCRYPTION_KEY in .env and restart the platform.");
  }
  await closeDatabase();
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "rotate-llm-key failed.");
  process.exit(1);
});
