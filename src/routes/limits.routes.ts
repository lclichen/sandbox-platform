/**
 * Limits routes: /api/v1/limits (authenticated, read-only).
 *
 * Clients need the effective upload caps to pre-check before streaming a large
 * file (and to display them). The write side lives under /api/v1/admin/limits.
 */
import { Router } from "express";
import { requireAuth } from "../auth/middleware.ts";
import { workspaceUploadLimitsView } from "../services/runtime-settings.ts";

export function limitsRouter(): Router {
  const router = Router();
  router.use(requireAuth());
  router.get("/", (_req, res) => {
    res.json(workspaceUploadLimitsView());
  });
  return router;
}
