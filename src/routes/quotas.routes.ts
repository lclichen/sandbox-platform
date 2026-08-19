/**
 * Admin quota routes: /api/v1/admin/quotas (admin only)
 *
 *   GET    /        list quotas
 *   POST   /        create quota
 *   GET    /:id     get quota
 *   PATCH  /:id     update quota
 *   DELETE /:id     delete quota
 */
import { Router } from "express";
import { getDb } from "../app.ts";
import { createQuotaService } from "../services/quota.service.ts";
import { requireAdmin } from "../auth/middleware.ts";
import { createQuotaSchema, updateQuotaSchema, idParamSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function quotasRouter(): Router {
  const router = Router();
  router.use(requireAdmin());

  router.get("/", (req, res, next) => {
    createQuotaService(getDb(req))
      .list()
      .then((rows) => res.json({ quotas: rows }))
      .catch(next);
  });

  router.post("/", (req, res, next) => {
    const body = validate(createQuotaSchema, req.body);
    createQuotaService(getDb(req))
      .create(body)
      .then((quota) => res.status(201).json(quota))
      .catch(next);
  });

  router.get("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    createQuotaService(getDb(req))
      .getById(id)
      .then((quota) => {
        if (!quota) {
          res.status(404).json({ code: "NOT_FOUND", message: `Quota ${id} not found` });
          return;
        }
        res.json(quota);
      })
      .catch(next);
  });

  router.patch("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(updateQuotaSchema, req.body);
    createQuotaService(getDb(req))
      .update(id, body)
      .then((quota) => res.json(quota))
      .catch(next);
  });

  router.delete("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    createQuotaService(getDb(req))
      .delete(id)
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}
