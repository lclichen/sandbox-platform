/**
 * User LLM routes: /api/v1/llm (any authenticated user; owner-scoped).
 *
 *   GET    /me                 my binding status + LiteLLM spend
 *   GET    /me/keys            my virtual keys (plaintext never included)
 *   DELETE /me/keys/:id        revoke one of my keys
 *   POST   /me/keys/:id/reveal decrypt + return a key's plaintext (sensitive)
 *   GET    /me/usage           my spend logs/report over a date range
 *   GET    /me/endpoint        base URL + usage instructions for direct LLM calls
 *   GET    /models             available LiteLLM models
 *
 * When LLM integration is disabled, every route returns 501 LLM_NOT_ENABLED.
 */
import { Router } from "express";
import { getLlmService } from "../app.ts";
import { requireAuth, currentUserId } from "../auth/middleware.ts";
import { llmKeyIdParamSchema, llmUsageQuerySchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function llmRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.get("/me", (req, res, next) => {
    getLlmService(req)
      .getMyStatus(currentUserId(req))
      .then((status) => res.json(status))
      .catch(next);
  });

  router.get("/me/keys", (req, res, next) => {
    getLlmService(req)
      .listMyKeys(currentUserId(req))
      .then((keys) => res.json({ keys }))
      .catch(next);
  });

  router.delete("/me/keys/:id", (req, res, next) => {
    const { id } = validate(llmKeyIdParamSchema, req.params);
    getLlmService(req)
      .revokeMyKey(id, currentUserId(req))
      .then(() => res.status(204).end())
      .catch(next);
  });

  // POST rather than GET: a revealed plaintext is a sensitive side-effect, and
  // GETs are cached/logged more readily by intermediaries.
  router.post("/me/keys/:id/reveal", (req, res, next) => {
    const { id } = validate(llmKeyIdParamSchema, req.params);
    getLlmService(req)
      .revealMyKey(id, currentUserId(req))
      .then((out) => res.json(out))
      .catch(next);
  });

  router.get("/me/usage", (req, res, next) => {
    const { startDate, endDate } = validate(llmUsageQuerySchema, req.query);
    getLlmService(req)
      .getMyUsage(currentUserId(req), { startDate, endDate })
      .then((usage) => res.json(usage))
      .catch(next);
  });

  router.get("/me/endpoint", (req, res, next) => {
    try {
      res.json(getLlmService(req).getEndpoint());
    } catch (err) {
      next(err);
    }
  });

  router.get("/models", (req, res, next) => {
    getLlmService(req)
      .listModels()
      .then((models) => res.json({ models }))
      .catch(next);
  });

  return router;
}
