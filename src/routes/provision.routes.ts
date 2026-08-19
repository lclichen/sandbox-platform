/**
 * Provisioning defaults route: /api/v1/provision (any authenticated user).
 *
 *   GET /defaults   -> one-click sandbox defaults for pi-web sessions (R6)
 *
 * Returns the platform-configured default image (PROVISION_DEFAULT_IMAGE_ID)
 * and seed-workspace template (PROVISION_DEFAULT_WORKSPACE_ID). When the env
 * ids are unset or stale, the first public image is offered and the workspace
 * falls back to null, so a pi-web client can always render a container
 * selector with sensible defaults in one request.
 */
import { Router, type Request } from "express";
import { getDb } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createImageService } from "../services/image.service.ts";
import { createWorkspaceService } from "../services/workspace.service.ts";
import { requireAuth, currentUserId, type AuthedRequest } from "../auth/middleware.ts";
import { UnauthorizedError } from "../utils/errors.ts";

function actor(req: Request): { id: number } {
  const user = (req as AuthedRequest).user;
  if (!user) throw new UnauthorizedError("Not authenticated");
  return { id: user.sub };
}

export function provisionRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.get("/defaults", (req, res, next) => {
    const cfg = loadConfig();
    const uid = actor(req).id;
    (async () => {
      const db = getDb(req);
      const images = createImageService(db);
      const workspaces = createWorkspaceService(db);

      let image = cfg.provision.defaultImageId
        ? await images.getById(cfg.provision.defaultImageId)
        : undefined;
      // Degrade to the first public image when unset or misconfigured.
      if (!image || !image.is_public) {
        const all = await images.list();
        image = all.find((img) => img.is_public);
      }

      let workspaceName: string | null = null;
      if (cfg.provision.defaultWorkspaceId) {
        // The template must be visible to this user (own or template).
        try {
          const ws = await workspaces.getById(cfg.provision.defaultWorkspaceId, uid);
          if (ws) workspaceName = ws.name;
        } catch {
          workspaceName = null;
        }
      }

      res.json({
        imageId: image?.id ?? null,
        imageName: image?.display_name ?? null,
        workspaceId: cfg.provision.defaultWorkspaceId || null,
        workspaceName,
      });
    })().catch(next);
  });

  return router;
}
