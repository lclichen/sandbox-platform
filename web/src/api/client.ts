/**
 * Thin fetch wrapper over the platform REST API.
 *
 * Auth tokens are supplied via a setter the AuthContext calls on login/logout,
 * keeping this module free of React imports. On 401 it transparently refreshes
 * once (using the stored refresh token) and retries the original request.
 */
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Token accessors are injected so AuthContext owns the source of truth.
let accessToken: string | undefined;
let refreshToken: string | undefined;
let onAuthFailure: (() => void) | undefined;
let onTokensRefreshed: ((access: string, refresh: string) => void) | undefined;

export function setAccessToken(token: string | undefined): void {
  accessToken = token;
}
export function setRefreshToken(token: string | undefined): void {
  refreshToken = token;
}
export function setOnAuthFailure(cb: () => void): void {
  onAuthFailure = cb;
}
export function setOnTokensRefreshed(cb: (access: string, refresh: string) => void): void {
  onTokensRefreshed = cb;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = { code: "http_error", message: `HTTP ${res.status}` };
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // non-JSON error; keep defaults
  }
  return new ApiError(res.status, body.code ?? "http_error", body.message ?? `HTTP ${res.status}`, body.details);
}

async function doFetch(path: string, method: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function refreshTokens(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const res = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const pair = (await res.json()) as { accessToken: string; refreshToken: string };
    accessToken = pair.accessToken;
    refreshToken = pair.refreshToken;
    onTokensRefreshed?.(pair.accessToken, pair.refreshToken);
    return true;
  } catch {
    return false;
  }
}

/** Core request method with automatic 401 refresh+retry. */
export async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const { method = "GET", body } = opts;
  let res = await doFetch(path, method, body);
  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      res = await doFetch(path, method, body);
    } else {
      onAuthFailure?.();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Serialize query params, dropping undefined/empty values so an empty
 *  search box (or optional filter) never emits e.g. `search=undefined`.
 *  Exported for testing — this guards against the classic URLSearchParams
 *  "undefined"-as-a-string regression. */
export function qs(params: Record<string, string | number | undefined>): string {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>,
  ).toString();
}

// ---- typed endpoint helpers ----
export const api = {
  // auth
  login: (username: string, password: string) =>
    request<{ accessToken: string; refreshToken: string; user: { id: number; username: string; role: string } }>(
      "/api/v1/auth/login",
      { method: "POST", body: { username, password } },
    ),
  me: () => request<{ user: { id: number; username: string; role: string } }>("/api/v1/auth/me"),
  // API keys are self-service: each user manages only their own keys.
  listMyApiKeys: () =>
    request<{
      apiKeys: Array<{
        id: number;
        name: string;
        key_prefix: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }>;
    }>("/api/v1/auth/api-keys"),
  createMyApiKey: (name: string) =>
    request<{ id: number; name: string; key: string; key_prefix: string }>("/api/v1/auth/api-keys", {
      method: "POST",
      body: { name },
    }),
  revokeMyApiKey: (id: number) => request<void>(`/api/v1/auth/api-keys/${id}`, { method: "DELETE" }),
  dashboard: () => request<import("./types").DashboardData>("/api/v1/admin/dashboard"),
  meDashboard: () =>
    request<{
      myContainers: number;
      runningContainers: number;
      recentFailures24h: number;
      containersByStatus: Record<string, number>;
    }>("/api/v1/auth/dashboard"),

  // users
  listUsers: (params: { limit?: number; offset?: number; search?: string } = {}) =>
    request<{ total: number; users: import("./types").UserPublic[] }>(
      `/api/v1/admin/users?${qs(params)}`,
    ),
  createUser: (body: { username: string; password: string; email?: string; role?: string; quota_id?: number }) =>
    request<import("./types").UserPublic>("/api/v1/admin/users", { method: "POST", body }),
  updateUser: (id: number, body: Partial<{ email: string; role: string; quota_id: number | null; status: string }>) =>
    request<import("./types").UserPublic>(`/api/v1/admin/users/${id}`, { method: "PATCH", body }),
  setUserPassword: (id: number, password: string) =>
    request<void>(`/api/v1/admin/users/${id}/password`, { method: "POST", body: { password } }),
  deleteUser: (id: number) => request<void>(`/api/v1/admin/users/${id}`, { method: "DELETE" }),

  // quotas
  listQuotas: () => request<{ quotas: import("./types").QuotaRow[] }>("/api/v1/admin/quotas"),
  createQuota: (body: Omit<import("./types").QuotaRow, "id" | "created_at" | "updated_at">) =>
    request<import("./types").QuotaRow>("/api/v1/admin/quotas", { method: "POST", body }),
  updateQuota: (id: number, body: Partial<import("./types").QuotaRow>) =>
    request<import("./types").QuotaRow>(`/api/v1/admin/quotas/${id}`, { method: "PATCH", body }),
  deleteQuota: (id: number) => request<void>(`/api/v1/admin/quotas/${id}`, { method: "DELETE" }),

  // images
  listImages: () => request<{ images: import("./types").ImageRow[] }>("/api/v1/admin/images"),
  publicImages: () => request<{ images: import("./types").ImageRow[] }>("/api/v1/images"),
  createImage: (body: {
    name: string;
    display_name: string;
    sif_path: string;
    description?: string;
    is_public?: boolean;
    tags?: string[];
    default_resources?: { cpu: number; memoryMb: number; diskGb: number };
  }) => request<import("./types").ImageRow>("/api/v1/admin/images", { method: "POST", body }),
  updateImage: (id: number, body: Partial<import("./types").ImageRow>) =>
    request<import("./types").ImageRow>(`/api/v1/admin/images/${id}`, { method: "PATCH", body }),
  deleteImage: (id: number) => request<void>(`/api/v1/admin/images/${id}`, { method: "DELETE" }),

  // containers: owner-scoped list (current user's own)
  listContainers: (params: { limit?: number; offset?: number; status?: string } = {}) =>
    request<{ containers: import("./types").ContainerPublic[] }>(`/api/v1/containers?${qs(params)}`),
  // containers: admin global list (all users)
  listAllContainers: (params: { limit?: number; offset?: number; status?: string } = {}) =>
    request<{ containers: import("./types").ContainerPublic[] }>(`/api/v1/admin/containers?${qs(params)}`),
  startContainer: (id: number) => request<import("./types").ContainerPublic>(`/api/v1/containers/${id}/start`, { method: "POST" }),
  stopContainer: (id: number) => request<import("./types").ContainerPublic>(`/api/v1/containers/${id}/stop`, { method: "POST" }),
  destroyContainer: (id: number) => request<void>(`/api/v1/containers/${id}`, { method: "DELETE" }),
  listSnapshots: (id: number) =>
    request<{ snapshots: import("./types").SnapshotRow[] }>(`/api/v1/containers/${id}/snapshots`),
  createSnapshot: (id: number, body: { name: string; description?: string }) =>
    request<{ id: number; name: string; sizeBytes: number }>(`/api/v1/containers/${id}/snapshots`, { method: "POST", body }),
  restoreSnapshot: (containerId: number, snapshotId: number) =>
    request<import("./types").ContainerPublic>(`/api/v1/containers/${containerId}/snapshots/${snapshotId}/restore`, { method: "POST" }),
  deleteSnapshot: (containerId: number, snapshotId: number) =>
    request<void>(`/api/v1/containers/${containerId}/snapshots/${snapshotId}`, { method: "DELETE" }),

  // logs
  listLogs: (params: {
    userId?: number;
    action?: string;
    resourceType?: string;
    resourceId?: number;
    status?: string;
    limit?: number;
    offset?: number;
  }) => request<{ total: number; logs: import("./types").LogRow[] }>(`/api/v1/admin/logs?${qs(params)}`),
  // per-user logs (current user only; userId forced server-side)
  myLogs: (params: {
    action?: string;
    resourceType?: string;
    resourceId?: number;
    status?: string;
    limit?: number;
    offset?: number;
  }) => request<{ total: number; logs: import("./types").LogRow[] }>(`/api/v1/logs?${qs(params)}`),

  // LLM integration (LiteLLM proxy). Admin endpoints manage bindings; user
  // endpoints are owner-scoped. When LLM is disabled these return 503
  // llm_not_enabled, which callers surface as a banner.
  listLlmBindings: () =>
    request<{ bindings: import("./types").LlmBinding[] }>("/api/v1/admin/llm/bindings"),
  grantLlmAccess: (body: {
    platformUserId: number;
    maxBudget: number;
    budgetDuration?: string | null;
    models?: string[] | null;
    defaultKeyName?: string;
  }) =>
    request<{ binding: import("./types").LlmBinding; key: { id: number; plaintext: string } }>(
      "/api/v1/admin/llm/bindings",
      { method: "POST", body },
    ),
  updateLlmBudget: (
    userId: number,
    body: { maxBudget?: number; budgetDuration?: string | null; models?: string[] | null },
  ) => request<{ binding: import("./types").LlmBinding }>(`/api/v1/admin/llm/bindings/${userId}`, { method: "PATCH", body }),
  revokeLlmAccess: (userId: number) => request<void>(`/api/v1/admin/llm/bindings/${userId}`, { method: "DELETE" }),
  getLlmBindingUsage: (userId: number, startDate: string, endDate: string) =>
    request<{ user: unknown; report: import("./types").LlmSpendEntry[]; logs: import("./types").LlmSpendEntry[] }>(
      `/api/v1/admin/llm/bindings/${userId}/usage?${qs({ startDate, endDate })}`,
    ),
  listLlmKeys: () => request<{ keys: import("./types").LlmVirtualKey[] }>("/api/v1/admin/llm/keys"),
  listLlmModels: () => request<{ models: import("./types").LlmModel[] }>("/api/v1/admin/llm/models"),
  // user (self-service)
  getMyLlmStatus: () => request<import("./types").LlmMyStatus>("/api/v1/llm/me"),
  listMyLlmKeys: () => request<{ keys: import("./types").LlmVirtualKey[] }>("/api/v1/llm/me/keys"),
  revokeMyLlmKey: (id: number) => request<void>(`/api/v1/llm/me/keys/${id}`, { method: "DELETE" }),
  revealMyLlmKey: (id: number) =>
    request<{ id: number; plaintext: string }>(`/api/v1/llm/me/keys/${id}/reveal`, { method: "POST" }),
  getMyLlmUsage: (startDate: string, endDate: string) =>
    request<{ user: unknown; report: import("./types").LlmSpendEntry[]; logs: import("./types").LlmSpendEntry[] }>(
      `/api/v1/llm/me/usage?${qs({ startDate, endDate })}`,
    ),
  getLlmEndpoint: () => request<import("./types").LlmEndpoint>("/api/v1/llm/me/endpoint"),
  getMyLlmModels: () => request<{ models: import("./types").LlmModel[] }>("/api/v1/llm/models"),

  // workspaces: persistent per-user file storage; seeds a container's /workspace on create
  listWorkspaces: (params: { limit?: number; offset?: number; search?: string } = {}) =>
    request<{ total: number; workspaces: import("./types").WorkspaceRow[] }>(
      `/api/v1/workspaces?${qs(params)}`,
    ),
  createWorkspace: (body: { name: string; description?: string; isTemplate?: boolean }) =>
    request<import("./types").WorkspaceRow>("/api/v1/workspaces", { method: "POST", body }),
  updateWorkspace: (
    id: number,
    body: Partial<{ name: string; description: string | null; isTemplate: boolean }>,
  ) => request<import("./types").WorkspaceRow>(`/api/v1/workspaces/${id}`, { method: "PATCH", body }),
  deleteWorkspace: (id: number) => request<void>(`/api/v1/workspaces/${id}`, { method: "DELETE" }),
  listWorkspaceFiles: (id: number, path: string = "/") =>
    request<{ path: string; entries: import("./types").WorkspaceFileEntry[] }>(
      `/api/v1/workspaces/${id}/files?${qs({ path })}`,
    ),
  /**
   * Upload a single file as an octet-stream. `dirPath` is the parent directory
   * inside the workspace (use "/" or "" for the root). Returns the new file's
   * path. NOTE: this bypasses the auto-401-refresh path because it sends a raw
   * Buffer; callers should rely on a fresh token at call time.
   */
  uploadWorkspaceFile: async (id: number, dirPath: string, filename: string, data: ArrayBuffer) => {
    const path = dirPath === "/" || dirPath === "" ? "" : dirPath;
    const res = await fetch(
      `/api/v1/workspaces/${id}/files?${qs({ path, name: filename })}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: data,
      },
    );
    if (res.status === 401) {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        onAuthFailure?.();
        throw new ApiError(401, "unauthorized", "Session expired");
      }
      return (await fetch(
        `/api/v1/workspaces/${id}/files?${qs({ path, name: filename })}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: data,
        },
      )).json();
    }
    if (!res.ok) throw await parseError(res);
    return res.json();
  },
  downloadWorkspaceFile: async (id: number, path: string): Promise<Blob> => {
    const url = `/api/v1/workspaces/${id}/files/content?${qs({ path })}`;
    const res = await fetch(url, {
      headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    });
    if (res.status === 401) {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        onAuthFailure?.();
        throw new ApiError(401, "unauthorized", "Session expired");
      }
      const retry = await fetch(url, {
        headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      });
      if (!retry.ok) throw await parseError(retry);
      return retry.blob();
    }
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },
  deleteWorkspaceFile: (id: number, path: string) =>
    request<void>(`/api/v1/workspaces/${id}/files?${qs({ path })}`, { method: "DELETE" }),
  makeWorkspaceDir: (id: number, path: string) =>
    request<{ path: string }>(`/api/v1/workspaces/${id}/dirs?${qs({ path })}`, { method: "POST" }),
};
