/**
 * Backup CLI: dump all application tables to a portable JSON archive.
 *
 * The format is dialect-agnostic (a JSON object of { table: rows[] }), so a
 * backup taken from sqlite can be restored into postgresql and vice versa.
 * This is the platform's "data backup and migration" primitive; migrate-db.ts
 * is a thin wrapper that chains a backup of the source with a restore into the
 * target.
 *
 * Usage:
 *   npm run backup                       # writes backups/<timestamp>.json
 *   npm run backup -- --out /path.json   # custom output path
 *   npm run backup -- --include-files    # ALSO tar overlays + workspaces
 *                                        # (P2-6: metadata alone is not a
 *                                        #  restorable backup of user files)
 *
 * Env: DB_DIALECT, DB_SQLITE_PATH, DATABASE_URL, OVERLAY_BASE_DIR,
 *      WORKSPACE_BASE_DIR (as usual).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createDatabase, closeDatabase, decodeJson } from "../src/db/driver.ts";
import { loadConfig } from "../src/config.ts";
import { logger } from "../src/utils/logger.ts";

// JSON columns: decode to logical JS values on read (backup) and re-encode on
// write (restore) so the archive is dialect-agnostic regardless of source.
export const JSON_COLUMNS: Record<string, string[]> = {
  images: ["tags", "default_resources"],
  containers: ["env"],
  operation_logs: ["detail"],
};

// Tables in dependency-safe order (parents before children) for restore.
export const TABLES = [
  "resource_quotas",
  "users",
  "images",
  "containers",
  "overlays",
  "snapshots",
  "sessions",
  "operation_logs",
  "refresh_tokens",
];

export interface BackupArchive {
  format: "sandbox-platform-backup";
  version: 1;
  createdAt: string;
  sourceDialect: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** Read every application table into a portable archive (JSON columns decoded). */
export async function buildArchive(db: import("../src/db/driver.ts").Database): Promise<BackupArchive> {
  const tables: BackupArchive["tables"] = {};
  const jsonCols = JSON_COLUMNS;
  for (const table of TABLES) {
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
    // Decode JSON columns to logical values so the archive is dialect-neutral.
    const cols = jsonCols[table] ?? [];
    tables[table] = rows.map((row) => {
      if (cols.length === 0) return row;
      const out: Record<string, unknown> = { ...row };
      for (const c of cols) {
        if (c in out) out[c] = decodeJson(out[c], db.dialect);
      }
      return out;
    });
  }
  return {
    format: "sandbox-platform-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    sourceDialect: db.dialect,
    tables,
  };
}

/**
 * Tar the file-storage directories (overlays + workspaces) into a companion
 * archive (P2-6). `--sparse` preserves ext3 overlay holes (manual §4.2).
 * Restore: extract the tar back over the same directories, then restore the
 * JSON metadata (see restore.ts).
 *
 * NOTE: on win32 the MSYS tar mis-parses absolute `C:\...` paths as remote
 * hosts; use relative paths (optionally with `cwd`) or POSIX-style config
 * paths there. Linux deployments (production) accept absolute paths.
 */
export async function tarFileDirs(
  outPath: string,
  dirs: string[],
  opts: { cwd?: string } = {},
): Promise<void> {
  if (dirs.length === 0) return;
  const args = ["--sparse", "-cSf", outPath, ...dirs];
  await new Promise<void>((resolveFn, reject) => {
    const child = spawn("tar", args, { stdio: "inherit", cwd: opts.cwd });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveFn();
      else reject(new Error(`tar failed with exit code ${code}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const includeFiles = args.includes("--include-files");

  const db = await createDatabase();
  try {
    const archive = await buildArchive(db);
    for (const [table, rows] of Object.entries(archive.tables)) {
      logger.info({ table, rows: rows.length }, "backed up");
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(outArg ?? `backups/backup-${timestamp}.json`);
    mkdirSync(resolve(outPath, ".."), { recursive: true });
    writeFileSync(outPath, JSON.stringify(archive, null, 2));
    logger.info({ outPath, totalRows: Object.values(archive.tables).reduce((a, r) => a + r.length, 0) }, "backup written");

    if (includeFiles) {
      const config = loadConfig();
      const fileDirs = [
        config.executor.apptainer.overlayBaseDir,
        config.executor.apptainer.workspaceBaseDir,
      ];
      const tarPath = resolve(outPath.replace(/\.json$/, "") + "-files.tar");
      await tarFileDirs(tarPath, fileDirs);
      logger.info({ tarPath, dirs: fileDirs }, "file storage tar written");
    }
  } finally {
    await closeDatabase();
  }
}

// Only run the CLI when invoked directly, not when imported (e.g. by tests).
if (process.argv[1]?.endsWith("backup.ts")) {
  main().catch((error) => {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Backup failed.");
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, "Backup failed.");
  process.exit(1);
});
