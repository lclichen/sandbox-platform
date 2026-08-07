/**
 * Idle-container reaper (manual §5.1).
 *
 * Background sweep that releases long-idle running containers to reclaim CPU /
 * memory: for each running container whose last activity (max of the most
 * recent session start/end and last_started_at) is older than
 * IDLE_AUTO_STOP_HOURS, it stops the instance, takes an auto-tier snapshot
 * (Stop-Then-Copy, no restart — the container stays released), and marks
 * `auto_stopped` so the next start/connect resumes from that snapshot.
 *
 * Also purges operation_logs older than AUDIT_RETENTION_DAYS (0 disables).
 *
 * The sweep is a plain function (`tick`) so tests can drive it directly; the
 * interval wrapper (`start`/`stop`) is unref'd so it never blocks shutdown.
 */
import { setInterval as nodeSetInterval } from "node:timers";
import type { Database, SqlValue } from "../db/driver.ts";
import { handleFromRow, type SandboxExecutor, type ContainerRowForExecutor } from "../executors/types.ts";
import { createContainerService } from "../services/container.service.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";

export interface ReaperSummary {
  scanned: number;
  reclaimed: Array<{ containerId: number; snapshotId: number | null }>;
  purgedAuditRows: number;
}

/** sqlite CURRENT_TIMESTAMP stores "YYYY-MM-DD HH:MM:SS" (UTC); pg returns ISO.
 *  Normalize to a timezone-explicit ISO string so Date.parse is host-TZ-safe. */
function parseDbUtc(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? 0 : t;
}

/** Auto-tier snapshot name, e.g. "auto-20260807-1630". */
function autoSnapshotName(tier: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
  return `${tier}-${stamp}`;
}

export interface Reaper {
  /** Run one sweep. Safe to call repeatedly; returns a summary. */
  tick(): Promise<ReaperSummary>;
  /** Start the periodic sweep (interval unref'd). No-op if already running. */
  start(): void;
  /** Stop the periodic sweep. */
  stop(): void;
}

export function createReaper(db: Database, executor: SandboxExecutor): Reaper {
  const config = loadConfig();
  const containers = createContainerService(db, executor);
  const idleMs = config.reaper.idleAutoStopHours * 3600 * 1000;
  let timer: ReturnType<typeof nodeSetInterval> | undefined;

  /** Last activity anchor for a container: most recent session start/end. */
  async function lastActivityMs(row: ContainerRowForExecutor): Promise<number> {
    const session = await db.get<{ latest: string | null }>(
      "SELECT MAX(COALESCE(ended_at, started_at)) AS latest FROM sessions WHERE container_id = ?",
      row.id,
    );
    return Math.max(parseDbUtc(session?.latest), parseDbUtc(row.last_started_at as string | null));
  }

  /** DELETE operation_logs older than AUDIT_RETENTION_DAYS. Returns rows removed. */
  async function purgeAuditLogs(): Promise<number> {
    const days = config.reaper.auditRetentionDays;
    if (!days || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    // sqlite stores "YYYY-MM-DD HH:MM:SS" (UTC); lexicographic compare needs the
    // same shape for the cutoff, otherwise the space-vs-T ordering skews the boundary.
    const bound = db.dialect === "sqlite" ? cutoff.replace("T", " ").replace(/\.\d{3}Z$/, "") : cutoff;
    const result = await db.run("DELETE FROM operation_logs WHERE created_at < ?", bound as SqlValue);
    if (result.changes > 0) logger.info({ removed: result.changes, days }, "reaper: purged old audit logs");
    return result.changes;
  }

  async function tick(): Promise<ReaperSummary> {
    const running = await db.all<ContainerRowForExecutor>(
      "SELECT id, user_id, instance_name, node, overlay_path, status, last_started_at, last_stopped_at FROM containers WHERE status = 'running'",
    );
    const summary: ReaperSummary = { scanned: running.length, reclaimed: [], purgedAuditRows: 0 };

    for (const row of running) {
      if (Date.now() - (await lastActivityMs(row)) < idleMs) continue;
      // Reclaim: quiesce → (optional) snapshot → mark auto_stopped.
      let snapshotId: number | null = null;
      try {
        const handle = handleFromRow(row);
        await executor.stop(handle);
        if (config.reaper.autoStopSnapshot) {
          const name = autoSnapshotName(config.reaper.snapshotTier);
          try {
            const snap = await containers.snapshot(
              row.id,
              row.user_id,
              name,
              `auto-stop at ${new Date().toISOString()}`,
              false,
              { restartAfter: false },
            );
            snapshotId = snap.id;
          } catch (err) {
            // Quota exceeded / snapshot failure must not block release.
            logger.warn({ containerId: row.id, err: (err as Error).message }, "reaper: auto snapshot failed; releasing anyway");
          }
        }
        const updated = await db.run(
          "UPDATE containers SET status = 'stopped', auto_stopped = 1, auto_stopped_at = CURRENT_TIMESTAMP, last_stopped_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
          row.id,
        );
        if (updated.changes > 0) {
          summary.reclaimed.push({ containerId: row.id, snapshotId });
          logger.info({ containerId: row.id, idleHours: config.reaper.idleAutoStopHours }, "reaper: container auto-stopped after idle threshold");
        }
      } catch (err) {
        logger.warn({ containerId: row.id, err: (err as Error).message }, "reaper: reclaim failed for container");
      }
    }

    summary.purgedAuditRows = await purgeAuditLogs();
    return summary;
  }

  return {
    tick,
    start() {
      if (timer) return;
      const intervalMs = Math.max(config.reaper.intervalMinutes, 1) * 60 * 1000;
      timer = nodeSetInterval(() => {
        void tick().catch((err) => {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, "reaper: sweep failed");
        });
      }, intervalMs);
      timer.unref?.();
      logger.info({ intervalMinutes: config.reaper.intervalMinutes }, "reaper: periodic sweep started");
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
