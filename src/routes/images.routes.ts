/**
 * Admin image routes: /api/v1/admin/images (admin only)
 *
 *   GET    /        list images
 *   POST   /        create image
 *   GET    /:id     get image
 *   PATCH  /:id     update image
 *   DELETE /:id     delete image
 */
import { Router } from "express";
import { getDb } from "../app.ts";
import { createImageService } from "../services/image.service.ts";
import { requireAdmin } from "../auth/middleware.ts";
import { createImageSchema, updateImageSchema, idParamSchema } from "./schemas/common.ts";
import { validate } from "./validate.ts";

export function imagesRouter(): Router {
  const router = Router();
  router.use(requireAdmin());

  router.get("/", (req, res, next) => {
    createImageService(getDb(req))
      .list()
      .then((rows) => res.json({ images: rows }))
      .catch(next);
  });

  router.post("/", (req, res, next) => {
    const body = validate(createImageSchema, req.body);
    createImageService(getDb(req))
      .create(body)
      .then((image) => res.status(201).json(image))
      .catch(next);
  });

  router.get("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    createImageService(getDb(req))
      .getById(id)
      .then((image) => {
        if (!image) {
          res.status(404).json({ code: "NOT_FOUND", message: `Image ${id} not found` });
          return;
        }
        res.json(image);
      })
      .catch(next);
  });

  router.patch("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    const body = validate(updateImageSchema, req.body);
    createImageService(getDb(req))
      .update(id, body)
      .then((image) => res.json(image))
      .catch(next);
  });

  router.delete("/:id", (req, res, next) => {
    const { id } = validate(idParamSchema, req.params);
    createImageService(getDb(req))
      .delete(id)
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}
