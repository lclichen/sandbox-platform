/**
 * Response types mirroring the sandbox-platform REST API.
 *
 * Kept in sync with src/routes/schemas and the service `toPublic` shapes.
 * Field names match the backend JSON exactly (snake_case for DB-derived rows).
 */

export interface UserPublic {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  quota_id: number | null;
  status: "active" | "disabled" | "pending";
  /** R9: set while the account owes a first-login password change. */
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface QuotaRow {
  id: number;
  name: string;
  description: string | null;
  max_containers: number;
  max_cpu_cores: number;
  max_memory_mb: number;
  max_disk_gb: number;
  max_snapshots_per_container: number;
  max_workspaces_per_user: number;
  /** R6: image-id whitelist; null = all public images. */
  allowed_image_ids: number[] | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  storage_path: string;
  size_bytes: number;
  file_count: number;
  source_container_id: number | null;
  is_template: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceFileEntry {
  name: string;
  /** POSIX-style relative path within the workspace (e.g. "sub/dir/f.txt"). */
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

export interface ImageRow {
  id: number;
  name: string;
  display_name: string;
  sif_path: string;
  description: string | null;
  is_public: boolean;
  tags: string[] | null;
  default_resources: { cpu: number; memoryMb: number; diskGb: number } | null;
  created_at: string;
  updated_at: string;
}

export interface ContainerPublic {
  id: number;
  user_id: number;
  image_id: number;
  name: string;
  instance_name: string | null;
  status: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  error_message: string | null;
  created_at: string;
  last_started_at: string | null;
  last_stopped_at: string | null;
}

export interface SnapshotRow {
  id: number;
  name: string;
  description: string | null;
  size_bytes: number;
  created_at: string;
}

export interface LogRow {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  detail: unknown;
  ip: string | null;
  status: "success" | "failure";
  error_message: string | null;
  created_at: string;
}

export interface DashboardData {
  users: number;
  images: number;
  runningContainers: number;
  recentFailures24h: number;
  containersByStatus: Record<string, number>;
  executor: string;
  dialect: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserPublic;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

// ----- LLM integration (LiteLLM proxy) -----

/** A platform user's LLM access binding. Mirrors LlmBindingPublic. */
export interface LlmBinding {
  id: number;
  platform_user_id: number;
  litellm_user_id: string;
  username: string;
  litellm_alias: string | null;
  max_budget: number;
  budget_duration: string | null;
  models: string[] | null;
  granted_at: string;
  granted_by: number;
  revoked_at: string | null;
}

/** A managed LiteLLM virtual key (plaintext never included). Mirrors LlmVirtualKeyPublic. */
export interface LlmVirtualKey {
  id: number;
  user_id: number;
  litellm_key_id: string | null;
  key_prefix: string;
  name: string;
  models: string[] | null;
  max_budget: number | null;
  budget_duration: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface LlmModel {
  id: string;
  object?: string;
  owned_by?: string;
}

/** Response from /llm/me: binding may be null when the user has no access. */
export interface LlmMyStatus {
  binding: LlmBinding | null;
  litellm: {
    user_id?: string;
    spend?: number;
    max_budget?: number | null;
    budget_duration?: string | null;
    models?: string[] | null;
  } | null;
}

export interface LlmEndpoint {
  baseUrl: string;
  instructions: string;
}

/** Spend report entry (shape is loose: LiteLLM varies group_by fields). */
export interface LlmSpendEntry {
  [key: string]: unknown;
}
