/**
 * One-time, short-lived PTY connection tickets (fix plan C3).
 *
 * Browsers cannot set Authorization headers on a WebSocket upgrade, and the
 * old `?token=<long-lived credential>` put a full account credential into
 * URLs (proxy access logs, browser history, Referer). Instead: an
 * authenticated REST call mints a single-use ticket bound to
 * {user, container} valid for 60 seconds; the WS upgrade accepts ONLY the
 * ticket. A leaked ticket is worthless seconds later and usable once.
 */
import { randomBytes } from "node:crypto";

export interface PtyTicket {
  ticket: string;
  userId: number;
  role: "admin" | "user";
  containerId: number;
  expiresAt: number;
}

interface TicketStore {
  tickets: Map<string, PtyTicket>;
  sweeper?: ReturnType<typeof setInterval>;
}

const SWEEP_MS = 30 * 1000;

const g = globalThis as unknown as { __piPtyTickets?: TicketStore };

function store(): TicketStore {
  if (!g.__piPtyTickets) g.__piPtyTickets = { tickets: new Map() };
  const s = g.__piPtyTickets;
  if (!s.sweeper) {
    s.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, t] of s.tickets) {
        if (t.expiresAt <= now) s.tickets.delete(key);
      }
    }, SWEEP_MS);
    s.sweeper.unref?.();
  }
  return s;
}

/** TTL is deliberately tight: the client connects immediately after minting. */
export const PTY_TICKET_TTL_MS = 60 * 1000;
/** Small per-user cap so tickets cannot be minted in unbounded numbers. */
const MAX_OUTSTANDING_PER_USER = 16;

export function issuePtyTicket(
  userId: number,
  role: "admin" | "user",
  containerId: number,
  ttlMs = PTY_TICKET_TTL_MS,
): { ticket: string; expiresAt: number } {
  const s = store();
  const now = Date.now();
  let outstanding = 0;
  for (const t of s.tickets.values()) {
    if (t.userId === userId && t.expiresAt > now) outstanding += 1;
  }
  if (outstanding >= MAX_OUTSTANDING_PER_USER) {
    throw Object.assign(new Error("Too many outstanding PTY tickets"), {
      status: 429,
      code: "PTY_TICKET_LIMIT",
    });
  }
  const ticket = randomBytes(24).toString("base64url");
  const expiresAt = now + ttlMs;
  s.tickets.set(ticket, { ticket, userId, role, containerId, expiresAt });
  return { ticket, expiresAt };
}

/**
 * Atomically consume a ticket for a given container. Returns null when the
 * ticket is unknown, expired, already used, or bound to another container.
 */
export function consumePtyTicket(
  raw: string | null | undefined,
  containerId: number,
): { userId: number; role: "admin" | "user" } | null {
  if (!raw) return null;
  const s = store();
  const t = s.tickets.get(raw);
  if (!t) return null;
  s.tickets.delete(raw); // single-use, even when the rest of the checks fail
  if (t.expiresAt <= Date.now()) return null;
  if (t.containerId !== containerId) return null;
  return { userId: t.userId, role: t.role };
}
