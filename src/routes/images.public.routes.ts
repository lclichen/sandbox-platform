/**
 * Public image routes: /api/v1/images (any authenticated user)
 *
 *   GET /          list PUBLIC images (for choosing a base when creating a container)
 *
 * Read-only. Admin management stays under /api/v1/admin/images.
 */
import { Router } from "express";
import { getDb } from "../app.ts";
import { createImageService } from "../services/image.service.ts";
import { requireAuth } from "../auth/middleware.ts";

export function publicImagesRouter(): Router {
  const router = Router();
  router.use(requireAuth());

  router.get("/", (req, res, next) => {
    createImageService(getDb(req))
      .list()
      .then((all) => {
        // Only expose public images to non-admin callers.
        const publicImages = all.filter((img) => img.is_public);
        res.json({ images: publicImages });
      })
      .catch(next);
  });

  return router;
}
