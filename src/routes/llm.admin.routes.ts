/**
 * Admin LLM routes: /api/v1/admin/llm (admin only)
 *
 *   GET    /bindings                list all LLM access bindings
 *   POST   /bindings                grant access (+ issue initial key)
 *   GET    /bindings/:userId        get one binding
 *   PATCH  /bindings/:userId        update budget / models
 *   DELETE /bindings/:userId        revoke access
 *   GET    /bindings/:userId/usage  spend for a bound user
 *   GET    /keys                    list all managed virtual keys
 *   GET    /models                  available LiteLLM models
 *
 * Every write is audited automatically by audit.middleware.ts.
 */
import { Router } from "express";
import { getDb, getLitellmClient, getLlmService } from "../app.ts";
import { requireAdmin } from "../auth/middleware.ts";
import { currentUserId } from "../auth/middleware.ts";
import {
  grantLlmAccessSchema,
  updateLlmBudgetSchema,
  llmUserIdParamSchema,
  llmUsageQuerySchema,
} from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function llmAdminRouter(): Router {
  const router = Router();
  router.use(requireAdmin());

  const service = (req: Parameters<typeof getDb>[0]) => getLlmService(req);

  router.get("/bindings", (req, res, next) => {
    service(req)
      .listBindings()
      .then((bindings) => res.json({ bindings }))
      .catch(next);
  });

  router.post("/bindings", (req, res, next) => {
    const body = validate(grantLlmAccessSchema, req.body);
    service(req)
      .grantAccess({ ...body, grantedBy: currentUserId(req) })
      .then(({ binding, key }) =>
        res.status(201).json({
          binding,
          // Plaintext returned exactly once, like platform API keys.
          key: { id: key.id, plaintext: key.plaintext },
        }),
      )
      .catch(next);
  });

  router.get("/bindings/:userId", (req, res, next) => {
    const { userId } = validate(llmUserIdParamSchema, req.params);
    service(req)
      .getBinding(userId)
      .then((binding) => {
        if (!binding) return res.status(404).json({ code: "not_found", message: `LLM binding for user ${userId} not found` });
        res.json({ binding });
      })
      .catch(next);
  });

  router.patch("/bindings/:userId", (req, res, next) => {
    const { userId } = validate(llmUserIdParamSchema, req.params);
    const body = validate(updateLlmBudgetSchema, req.body);
    service(req)
      .updateBudget(userId, body, currentUserId(req))
      .then((binding) => res.json({ binding }))
      .catch(next);
  });

  router.delete("/bindings/:userId", (req, res, next) => {
    const { userId } = validate(llmUserIdParamSchema, req.params);
    service(req)
      .revokeAccess(userId)
      .then(() => res.status(204).end())
      .catch(next);
  });

  router.get("/bindings/:userId/usage", (req, res, next) => {
    const { userId } = validate(llmUserIdParamSchema, req.params);
    const { startDate, endDate } = validate(llmUsageQuerySchema, req.query);
    service(req)
      .getBindingUsage(userId, { startDate, endDate })
      .then((usage) => res.json(usage))
      .catch(next);
  });

  router.get("/keys", (req, res, next) => {
    service(req)
      .listAllKeys()
      .then((keys) => res.json({ keys }))
      .catch(next);
  });

  router.get("/models", (req, res, next) => {
    getLitellmClient(req)
      .listModels()
      .then((models) => res.json({ models }))
      .catch(next);
  });

  return router;
}
