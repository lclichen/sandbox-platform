/**
 * Request validation schemas (zod). Each router imports the schemas it needs
 * and applies them on req.body / req.query.
 */
import { z } from "zod";

// ----- auth -----
export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// R1: self-registration. Password policy (length/complexity) is additionally
// enforced server-side against env config in the register handler.
export const registerSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Letters, digits, _ . - only"),
  password: z.string().min(1).max(256),
  email: z.string().email().optional(),
});

// R9: self-service password change.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

// ----- users -----
export const createUserSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/, "Letters, digits, _ . - only"),
  password: z.string().min(8).max(256),
  email: z.string().email().optional(),
  role: z.enum(["admin", "user"]).optional(),
  quota_id: z.number().int().positive().optional(),
  /** R9: force a password change on first login (admin-created accounts). */
  mustChangePassword: z.boolean().optional(),
});

export const updateUserSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(["admin", "user"]).optional(),
  quota_id: z.number().int().positive().nullable().optional(),
  status: z.enum(["active", "disabled", "pending"]).optional(),
});

export const setPasswordSchema = z.object({
  password: z.string().min(8).max(256),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  // Normalize search so an empty box (or a client that serializes `undefined`
  // as the string "undefined") degrades to "no filter" instead of a LIKE that
  // matches nothing.
  search: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v !== "undefined" ? v : undefined)),
});

// R1: admin user listing may filter by status (approval queue).
export const listUsersSchema = paginationSchema.extend({
  status: z.enum(["active", "disabled", "pending"]).optional(),
});

// ----- quotas -----
export const createQuotaSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "Letters, digits, _ - only"),
  description: z.string().max(512).optional(),
  max_containers: z.number().int().min(0).max(1000),
  max_cpu_cores: z.number().int().min(0).max(1024),
  max_memory_mb: z.number().int().min(0),
  max_disk_gb: z.number().int().min(0),
  max_snapshots_per_container: z.number().int().min(0),
  max_workspaces_per_user: z.number().int().min(0).max(10000).optional(),
  /** R6: image-id whitelist; null/empty = all public images. */
  allowed_image_ids: z.array(z.number().int().positive()).nullable().optional(),
});

export const updateQuotaSchema = createQuotaSchema.partial();

// ----- images -----
export const createImageSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\/-]+$/, "Letters, digits, _ . / - only"),
  display_name: z.string().min(1).max(128),
  sif_path: z.string().min(1).max(1024),
  description: z.string().max(2048).optional(),
  is_public: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  default_resources: z
    .object({
      cpu: z.number().int().min(1).max(1024),
      memoryMb: z.number().int().min(128),
      diskGb: z.number().int().min(1),
    })
    .optional(),
});

export const updateImageSchema = createImageSchema.partial();

// Common id param validator.
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ----- containers -----
export const createContainerSchema = z.object({
  imageId: z.number().int().positive(),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\s-]+$/, "Letters, digits, _ . space - only"),
  cpu: z.number().int().min(1).max(1024).optional(),
  memoryMb: z.number().int().min(128).optional(),
  diskGb: z.number().int().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  workspaceId: z.number().int().positive().optional(),
});

export const listContainersSchema = paginationSchema.extend({
  status: z.string().optional(),
  /** R6: running|stopped|all — friendly alias for status, pi-web-facing. */
  filter: z.enum(["running", "stopped", "all"]).optional(),
  /** R6: only containers created from this image id. */
  image: z.coerce.number().int().positive().optional(),
});

export const createSnapshotSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/, "Letters, digits, _ . - only"),
  description: z.string().max(2048).optional(),
});

// ----- tools (container operations relayed from pi extension) -----
export const readToolSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const writeToolSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().min(1), // base64
});

export const editToolSchema = z.object({
  path: z.string().min(1).max(4096),
  oldText: z.string(),
  newText: z.string(),
});

export const bashToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().max(4096).optional(),
  timeout: z.number().int().min(1).max(3600).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const grepToolSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().max(4096).optional(),
  glob: z.string().max(1024).optional(),
  literal: z.boolean().optional(),
  ignoreCase: z.boolean().optional(),
  context: z.number().int().min(0).max(50).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const findToolSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

// ----- workspaces -----
export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\s-]+$/, "Letters, digits, _ . space - only"),
  description: z.string().max(2048).optional(),
  isTemplate: z.boolean().optional(),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\s-]+$/, "Letters, digits, _ . space - only").optional(),
  description: z.string().max(2048).nullable().optional(),
  isTemplate: z.boolean().optional(),
});

export const listWorkspacesSchema = paginationSchema;

// Workspace file path: a non-empty relative path with no shell/host metacharacters.
export const workspacePathSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\u0000<>:"|?*]+$/, "Path contains forbidden characters"),
});

export const workspaceDirSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\u0000<>:"|?*]+$/, "Path contains forbidden characters"),
});

// R5: move/rename. `to` is either a new full path, or a target directory when
// it ends with "/" (mv semantics).
export const moveFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\u0000<>:"|?*]+$/, "Path contains forbidden characters"),
  to: z.string().min(1).max(1024),
});

// R5: chunked upload session start.
export const initUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().min(0).optional(),
});

// ----- LLM integration -----
// LiteLLM budget_duration uses values like "1d"/"30d"/"24h"; we accept the same
// vocabulary and let LiteLLM validate.
const budgetDurationSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^\d+(s|m|h|d)$/, "Use a number followed by s/m/h/d (e.g. 1d, 24h, 30d)")
  .nullable()
  .optional();

export const grantLlmAccessSchema = z.object({
  platformUserId: z.number().int().positive(),
  maxBudget: z.number().min(0).max(1_000_000),
  budgetDuration: budgetDurationSchema,
  models: z.array(z.string().min(1).max(128)).nullable().optional(),
  defaultKeyName: z.string().min(1).max(128).optional(),
});

export const updateLlmBudgetSchema = z.object({
  maxBudget: z.number().min(0).max(1_000_000).optional(),
  budgetDuration: budgetDurationSchema,
  models: z.array(z.string().min(1).max(128)).nullable().optional(),
});

export const llmUserIdParamSchema = z.object({
  userId: z.coerce.number().int().positive(),
});

export const llmKeyIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const llmUsageQuerySchema = z.object({
  startDate: z.string().min(1).max(32),
  endDate: z.string().min(1).max(32),
});
