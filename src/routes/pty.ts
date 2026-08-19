/**
 * PTY WebSocket bridge (R2): GET /api/v1/containers/:id/pty?token=<credential>
 *
 * Bridges a browser/pi-web xterm frontend onto an interactive shell inside the
 * owner's container. Owner isolation reuses container.service.requireOwned
 * (404 for non-owners, same as the REST tools routes).
 *
 * Frame protocol (JSON text frames, mirrors pi-web's existing terminal):
 *   server -> client: {type:"ready"} | {type:"output", data} | {type:"exit", code}
 *   client -> server: {type:"input", data} | {type:"resize", cols, rows}
 *
 * Limits (env-configurable):
 *   - PTY_MAX_PER_CONTAINER concurrent sessions per container (default 3);
 *     excess upgrades are refused with HTTP 429.
 *   - PTY_IDLE_TIMEOUT_MINUTES: sessions with no client traffic for this long
 *     are killed (default 30). Server pings every 30s also detect dead peers.
 *
 * Every connection is recorded in the `sessions` audit table (openSession /
 * closeSession with byte counters), matching the SSE bash/stream accounting.
 *
 * Auth note: browsers cannot set headers on WebSocket upgrades, hence the
 * `token` query parameter (JWT access token or `sk_` API key). Deployments
 * should keep WS URLs out of access logs (see docs/DEPLOYMENT.md).
 */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Database } from "../db/driver.ts";
import type { SandboxExecutor } from "../executors/types.ts";
import { createContainerService } from "../services/container.service.ts";
import { authenticateCredential } from "../auth/middleware.ts";
import { loadConfig } from "../config.ts";
import { logger } from "../utils/logger.ts";

const PTY_PATH_RE = /^\/api\/v1\/containers\/(\d+)\/pty$/;

export interface PtyServerDeps {
  db: Database;
  executor: SandboxExecutor;
}

/** Reply to a rejected WebSocket upgrade with a normal HTTP error response. */
function rejectHttp(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ code, message });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "Content-Type: application/json\r\n" +
      "Connection: close\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

interface ClientFrame {
  type: "input" | "resize" | "ping";
  data?: string;
  cols?: number;
  rows?: number;
}

/**
 * Attach the PTY WebSocket endpoint to an existing HTTP server (index.ts).
 * State (per-container connection counts) is scoped to this attachment.
 */
export function attachPtyServer(server: HttpServer, deps: PtyServerDeps): void {
  const { db, executor } = deps;
  const wss = new WebSocketServer({ noServer: true });
  const openPerContainer = new Map<number, number>();

  const increment = (containerId: number): number => {
    const n = (openPerContainer.get(containerId) ?? 0) + 1;
    openPerContainer.set(containerId, n);
    return n;
  };
  const decrement = (containerId: number): void => {
    const n = (openPerContainer.get(containerId) ?? 1) - 1;
    if (n <= 0) openPerContainer.delete(containerId);
    else openPerContainer.set(containerId, n);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = PTY_PATH_RE.exec(url.pathname);
      if (!match) {
        rejectHttp(socket, 404, "NOT_FOUND", "Resource not found");
        return;
      }
      const containerId = Number(match[1]);
      const token = url.searchParams.get("token");
      if (!token) {
        rejectHttp(socket, 401, "UNAUTHORIZED", "Missing ?token= credential");
        return;
      }
      const claims = await authenticateCredential(db, token);
      if (!claims) {
        rejectHttp(socket, 401, "UNAUTHORIZED", "Invalid or expired credential");
        return;
      }
      if (claims.pwd_change_required) {
        rejectHttp(socket, 403, "PASSWORD_CHANGE_REQUIRED", "Password change required");
        return;
      }

      const cfg = loadConfig();
      const svc = createContainerService(db, executor);
      let row: Awaited<ReturnType<typeof svc.resolveRunningHandle>>["row"];
      try {
        // requireOwned semantics (404 for non-owners) + running check in one call.
        const resolved = await svc.resolveRunningHandle(containerId, claims.sub, claims.role === "admin");
        row = resolved.row;
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        const code = (err as { code?: string }).code ?? "INTERNAL_ERROR";
        const message = (err as Error).message ?? "Container lookup failed";
        rejectHttp(socket, status, code, message);
        return;
      }

      const open = openPerContainer.get(containerId) ?? 0;
      if (open >= cfg.pty.maxPerContainer) {
        rejectHttp(
          socket,
          429,
          "PTY_LIMIT_REACHED",
          `Container ${containerId} already has ${open} terminal session(s); limit ${cfg.pty.maxPerContainer}`,
        );
        return;
      }
      if (typeof executor.openPty !== "function") {
        rejectHttp(socket, 501, "PTY_NOT_SUPPORTED", `Executor '${executor.kind}' does not support terminals`);
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        bridgePty(ws, executor, {
          containerId,
          containerUserId: row.user_id,
          instanceName: row.instance_name ?? `sb-${containerId}`,
          node: row.node ?? "local",
          overlayPath: row.overlay_path ?? "",
        }).catch((err) => {
          logger.error({ err: (err as Error).message, containerId }, "PTY bridge failed after upgrade.");
          ws.close(1011, "pty error");
        });
      });
    })().catch((err) => {
      logger.error({ err: (err as Error).message }, "PTY upgrade error.");
      rejectHttp(socket, 500, "INTERNAL_ERROR", "Upgrade failed");
    });
  });

  async function bridgePty(
    ws: WebSocket,
    exec: SandboxExecutor,
    info: {
      containerId: number;
      containerUserId: number;
      instanceName: string;
      node: string;
      overlayPath: string;
    },
  ): Promise<void> {
    const cfg = loadConfig();
    const svc = createContainerService(db, exec);
    const sessionId = await svc.openSession(info.containerId, info.containerUserId);
    increment(info.containerId);

    let bytesIn = 0;
    let bytesOut = 0;
    let settled = false;
    let lastActivity = Date.now();

    const settle = (reason: string) => {
      if (settled) return;
      settled = true;
      decrement(info.containerId);
      clearInterval(keepalive);
      void svc.closeSession(sessionId, bytesIn, bytesOut).catch(() => {
        /* best-effort accounting */
      });
      logger.info({ containerId: info.containerId, sessionId, reason, bytesIn, bytesOut }, "PTY session closed.");
    };

    // Keepalive + idle sweep: ping every 30s (pong refreshes lastActivity);
    // kill sessions with no client traffic beyond the idle timeout.
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
      if (Date.now() - lastActivity > cfg.pty.idleTimeoutMinutes * 60_000) {
        settle("idle");
        try {
          pty?.kill();
        } catch {
          /* already gone */
        }
        ws.close(4000, "idle timeout");
      }
    }, 30_000);
    keepalive.unref?.();

    ws.on("pong", () => {
      lastActivity = Date.now();
    });

    let pty: Awaited<ReturnType<NonNullable<typeof exec.openPty>>> | undefined;
    try {
      pty = await exec.openPty!(
        { id: info.instanceName, node: info.node, overlayPath: info.overlayPath, running: true },
        { cols: 80, rows: 24 },
      );
    } catch (err) {
      settle("open-failed");
      logger.error({ err: (err as Error).message, containerId: info.containerId }, "openPty failed.");
      ws.close(1011, "pty unavailable");
      return;
    }

    pty.onData((chunk: Buffer) => {
      bytesOut += chunk.byteLength;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
      }
    });
    pty.onExit((code) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code }));
      }
      settle("exited");
      setTimeout(() => ws.close(1000, "shell exited"), 50);
    });

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      lastActivity = Date.now();
      if (isBinary) {
        ws.close(4400, "binary frames not supported");
        return;
      }
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString("utf8")) as ClientFrame;
      } catch {
        ws.close(4400, "invalid json frame");
        return;
      }
      switch (frame.type) {
        case "input":
          if (typeof frame.data === "string") {
            bytesIn += Buffer.byteLength(frame.data);
            pty?.write(frame.data);
          }
          break;
        case "resize":
          if (
            Number.isInteger(frame.cols) &&
            Number.isInteger(frame.rows) &&
            (frame.cols as number) > 0 &&
            (frame.cols as number) <= 1000 &&
            (frame.rows as number) > 0 &&
            (frame.rows as number) <= 1000
          ) {
            pty?.resize(frame.cols as number, frame.rows as number);
          }
          break;
        case "ping":
          // Client keepalive; activity already recorded above.
          break;
        default:
          ws.close(4400, "unknown frame type");
      }
    });

    ws.on("close", () => {
      try {
        pty?.kill();
      } catch {
        /* already gone */
      }
      settle("client-closed");
    });
    ws.on("error", () => {
      try {
        pty?.kill();
      } catch {
        /* already gone */
      }
      settle("error");
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ready" }));
    }
    logger.info({ containerId: info.containerId, sessionId }, "PTY session opened.");
  }
}
