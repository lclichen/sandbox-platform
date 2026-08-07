/**
 * Image catalogue service.
 *
 * Admins manage the base SIF images that users can launch containers from.
 * Images carry optional default resource suggestions consumed by the
 * container create flow when the caller omits cpu/memory/disk.
 */
import type { Database, SqlValue } from "../db/driver.ts";
import { decodeJson, encodeJson } from "../db/driver.ts";
import { ConflictError, NotFoundError } from "../utils/errors.ts";

export interface ImageRow {
  id: number;
  name: string;
  display_name: string;
  sif_path: string;
  description: string | null;
  is_public: boolean | number;
  tags: string[] | null;
  default_resources: { cpu: number; memoryMb: number; diskGb: number } | null;
  created_at: string;
  updated_at: string;
}

export interface ImageInput {
  name: string;
  display_name: string;
  sif_path: string;
  description?: string;
  is_public?: boolean;
  tags?: string[];
  default_resources?: { cpu: number; memoryMb: number; diskGb: number };
}

function decode(row: Omit<ImageRow, "tags" | "default_resources" | "is_public"> & Record<string, unknown>, dialect: string): ImageRow {
  return {
    ...row,
    is_public: dialect === "sqlite" ? Boolean(row.is_public) : (row.is_public as boolean),
    tags: decodeJson<string[]>(row.tags, dialect as never),
    default_resources: decodeJson<ImageRow["default_resources"]>(row.default_resources, dialect as never),
  };
}

export function createImageService(db: Database) {
  return {
    async getById(id: number): Promise<ImageRow | null> {
      const raw = await db.get<Omit<ImageRow, "tags" | "default_resources" | "is_public"> & Record<string, unknown>>(
        "SELECT * FROM images WHERE id = ?",
        id,
      );
      return raw ? decode(raw, db.dialect) : null;
    },

    async requireById(id: number): Promise<ImageRow> {
      const row = await this.getById(id);
      if (!row) throw new NotFoundError("Image", id);
      return row;
    },

    async list(): Promise<ImageRow[]> {
      const rows = await db.all<Omit<ImageRow, "tags" | "default_resources" | "is_public"> & Record<string, unknown>>(
        "SELECT * FROM images ORDER BY id",
      );
      return rows.map((r) => decode(r, db.dialect));
    },

    async create(input: ImageInput): Promise<ImageRow> {
      const existing = await db.get<{ id: number }>("SELECT id FROM images WHERE name = ?", input.name);
      if (existing) throw new ConflictError(`Image '${input.name}' already exists`);
      const result = await db.run(
        `INSERT INTO images (name, display_name, sif_path, description, is_public, tags, default_resources)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.name,
        input.display_name,
        input.sif_path,
        input.description ?? null,
        input.is_public ?? true,
        encodeJson(input.tags ?? null, db.dialect) as SqlValue,
        encodeJson(input.default_resources ?? null, db.dialect) as SqlValue,
      );
      return (await this.getById(Number(result.lastInsertRowid)))!;
    },

    async update(id: number, patch: Partial<ImageInput>): Promise<ImageRow> {
      const current = await this.requireById(id);
      const sets: string[] = [];
      const values: SqlValue[] = [];
      const map: Record<string, string> = {
        display_name: "display_name",
        sif_path: "sif_path",
        description: "description",
      };
      for (const key of Object.keys(map)) {
        const v = patch[key as keyof ImageInput];
        if (v === undefined) continue;
        sets.push(`${map[key]} = ?`);
        values.push(v as SqlValue);
      }
      if (patch.is_public !== undefined) {
        sets.push("is_public = ?");
        values.push(patch.is_public);
      }
      if (patch.tags !== undefined) {
        sets.push("tags = ?");
        values.push(encodeJson(patch.tags, db.dialect) as SqlValue);
      }
      if (patch.default_resources !== undefined) {
        sets.push("default_resources = ?");
        values.push(encodeJson(patch.default_resources, db.dialect) as SqlValue);
      }
      if (sets.length === 0) return current;
      values.push(id);
      await db.run(`UPDATE images SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, ...values);
      return (await this.getById(id))!;
    },

    async delete(id: number): Promise<void> {
      const inUse = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM containers WHERE image_id = ?", id);
      if (Number(inUse?.c ?? 0) > 0) {
        throw new ConflictError("Image is referenced by containers; remove them first");
      }
      await db.run("DELETE FROM images WHERE id = ?", id);
    },
  };
}

export type ImageService = ReturnType<typeof createImageService>;
