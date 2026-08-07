/**
 * Admin user routes: /api/v1/admin/users (admin only)
 *
 *   GET    /              list users (paginated)
 *   POST   /              create user
 *   GET    /:id           get user
 *   PATCH  /:id           update user (email/role/quota_id/status)
 *   POST   /:id/password  set password
 *   DELETE /:id           delete user
 */
import { Router } from "express";
import { getDb } from "../app.ts";
import { createUserService, toPublic } from "../services/user.service.ts";
import { requireAdmin, type AuthedRequest } from "../auth/middleware.ts";
import {
  createUserSchema,
  updateUserSchema,
  setPasswordSchema,
  paginationSchema,
  idParamSchema,
} from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function usersRouter(): Router {
  const router = Router();
  router.use(requireAdmin());

  router.get("/", (req, res, next) => {
    const query = validate(paginationSchema, req.query);
    const users = createUserService(getDb(req));
    Promise.all([users.list(query), users.count(query.search)])
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
    const users = createUserService(getDb(req));
    users
      .create(body)
      .then((user) => res.status(201).json(toPublic(user)))
      .catch(next);
  });

  router.get("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const users = createUserService(getDb(req));
    users
      .getById(id)
      .then((user) => {
        if (!user) {
          res.status(404).json({ code: "not_found", message: `User ${id} not found` });
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
      res.status(400).json({ code: "bad_request", message: "Cannot delete your own account" });
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
