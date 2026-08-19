/**
 * Admin user routes: /api/v1/admin/users (admin only)
 *
 *   GET    /                list users (paginated; ?status=pending = approval queue)
 *   POST   /                create user
 *   GET    /:id             get user
 *   PATCH  /:id             update user (email/role/quota_id/status)
 *   POST   /:id/password    set password
 *   POST   /:id/approve     approve a pending self-registration (R1)
 *   POST   /:id/reject      reject a pending self-registration (deletes it) (R1)
 *   POST   /import          batch-import users from CSV text (R1)
 *   DELETE /:id             delete user
 */
import { Router } from "express";
import { z } from "zod";
import { getDb } from "../app.ts";
import { createUserService, toPublic } from "../services/user.service.ts";
import { validatePasswordPolicy } from "../auth/password.ts";
import { BadRequestError } from "../utils/errors.ts";
import { requireAdmin, type AuthedRequest } from "../auth/middleware.ts";
import {
  createUserSchema,
  updateUserSchema,
  setPasswordSchema,
  listUsersSchema,
  idParamSchema,
} from "./schemas/common.ts";
import { validate } from "./validate.ts";

/** R1: CSV import body — raw CSV text plus the import-wide options. */
const importUsersSchema = z.object({
  csv: z.string().min(1).max(1_000_000),
  /** Force a password change on first login for every imported account. */
  mustChangePassword: z.boolean().optional(),
  /** Quota assigned to imported accounts; unset = platform default row. */
  quota_id: z.number().int().positive().optional(),
});

interface ImportRowResult {
  username: string;
  ok: boolean;
  error?: string;
}

/**
 * Parse `username,password[,email]` CSV lines. A header line whose first cell
 * is literally "username" is skipped, as are blank lines and # comments.
 */
function parseUsersCsv(csv: string): Array<{ username: string; password: string; email?: string }> {
  const out: Array<{ username: string; password: string; email?: string }> = [];
  const lines = csv.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split(",").map((c) => c.trim());
    if (i === 0 && cells[0].toLowerCase() === "username") continue; // header
    const [username, password, email] = cells;
    out.push({ username, password, email: email || undefined });
  }
  return out;
}

export function usersRouter(): Router {
  const router = Router();
  router.use(requireAdmin());

  router.get("/", (req, res, next) => {
    const query = validate(listUsersSchema, req.query);
    const users = createUserService(getDb(req));
    Promise.all([users.list(query), users.count(query.search, query.status)])
      .then(([rows, total]) =>
        res.json({
          total,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
          users: rows.map(toPublic),
        }),
      )
      .catch(next);
  });

  router.post("/", (req, res, next) => {
    const body = validate(createUserSchema, req.body);
    const violation = validatePasswordPolicy(body.password);
    if (violation) {
      next(new BadRequestError(violation));
      return;
    }
    const users = createUserService(getDb(req));
    users
      .create(body)
      .then((user) => res.status(201).json(toPublic(user)))
      .catch(next);
  });

  // R1: activate a pending self-registration.
  router.post("/:id/approve", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    createUserService(getDb(req))
      .approve(id)
      .then((user) => res.json(toPublic(user)))
      .catch(next);
  });

  // R1: reject a pending self-registration — the account never logged in, so
  // removal (rather than disable) keeps the approval queue unambiguous.
  router.post("/:id/reject", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const users = createUserService(getDb(req));
    (async () => {
      const row = await users.getById(id);
      if (!row) {
        res.status(404).json({ code: "NOT_FOUND", message: `User ${id} not found` });
        return;
      }
      if (row.status !== "pending") {
        res
          .status(409)
          .json({ code: "INVALID_STATE", message: `Cannot reject a user in '${row.status}' state` });
        return;
      }
      await users.delete(id);
      res.status(204).end();
    })().catch(next);
  });

  // R1: batch import for course onboarding. Returns per-row results so the
  // admin sees exactly which lines failed (duplicates, policy violations).
  router.post("/import", (req, res, next) => {
    const body = validate(importUsersSchema, req.body);
    (async () => {
      const db = getDb(req);
      const users = createUserService(db);
      const rows = parseUsersCsv(body.csv);
      if (rows.length === 0) {
        res.status(400).json({ code: "BAD_REQUEST", message: "CSV contained no user rows" });
        return;
      }
      if (rows.length > 500) {
        res.status(400).json({ code: "BAD_REQUEST", message: "Import limited to 500 rows per call" });
        return;
      }
      let defaultQuotaId = body.quota_id;
      if (!defaultQuotaId) {
        const q = await db.get<{ id: number }>("SELECT id FROM resource_quotas ORDER BY id LIMIT 1");
        defaultQuotaId = q?.id;
      }
      const results: ImportRowResult[] = [];
      for (const row of rows) {
        try {
          if (!row.username || !row.password) throw new Error("missing username or password");
          const violation = validatePasswordPolicy(row.password);
          if (violation) throw new Error(violation);
          await users.create({
            username: row.username,
            password: row.password,
            email: row.email,
            quota_id: defaultQuotaId,
            mustChangePassword: body.mustChangePassword ?? false,
          });
          results.push({ username: row.username, ok: true });
        } catch (err) {
          results.push({
            username: row.username,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const created = results.filter((r) => r.ok).length;
      res.status(created > 0 ? 201 : 400).json({ created, failed: results.length - created, results });
    })().catch(next);
  });

  router.get("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const users = createUserService(getDb(req));
    users
      .getById(id)
      .then((user) => {
        if (!user) {
          res.status(404).json({ code: "NOT_FOUND", message: `User ${id} not found` });
          return;
        }
        res.json(toPublic(user));
      })
      .catch(next);
  });

  router.patch("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(updateUserSchema, req.body);
    const users = createUserService(getDb(req));
    users
      .update(id, body)
      .then((user) => res.json(toPublic(user)))
      .catch(next);
  });

  router.post("/:id/password", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(setPasswordSchema, req.body);
    const violation = validatePasswordPolicy(body.password);
    if (violation) {
      next(new BadRequestError(violation));
      return;
    }
    const users = createUserService(getDb(req));
    users
      .setPassword(id, body.password)
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.delete("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const requester = (req as AuthedRequest).user!;
    if (id === requester.sub) {
      res.status(400).json({ code: "BAD_REQUEST", message: "Cannot delete your own account" });
      return;
    }
    const users = createUserService(getDb(req));
    users
      .delete(id)
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}
