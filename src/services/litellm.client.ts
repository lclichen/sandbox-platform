/**
 * LiteLLM proxy (ai-gateway) HTTP client.
 *
 * The platform talks to LiteLLM's management API as the master-key holder to
 * provision users, issue virtual keys, set budgets, and read spend. LLM traffic
 * itself (chat/completions, messages) does NOT flow through the platform —
 * clients take an issued virtual key and hit LiteLLM directly.
 *
 * Auth: all calls carry `Authorization: Bearer <masterKey>`.
 * Errors: LiteLLM shapes are mapped onto the platform's HttpError hierarchy so
 * route handlers can throw transparently. Notably:
 *   - budget exhaustion  -> 400 with body type "budget_exceeded"  -> QuotaExceededError(422)
 *   - rate-limit         -> 429                                  -> RateLimitError(429)
 *   - auth failures      -> 401/403                              -> UnauthorizedError(401)
 *   - network/timeout    ->                                      -> HttpError(503, llm_unreachable)
 *
 * Reference: https://docs.litellm.ai/docs/proxy/virtual_keys
 */
import { HttpError, UnauthorizedError, QuotaExceededError, NotFoundError, BadRequestError } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";

/** LiteLLM returned 429 — TPM/RPM or concurrency limit hit. */
export class RateLimitError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(429, "rate_limited", message, details);
  }
}

export interface LitellmClientOptions {
  baseUrl: string;
  masterKey: string;
  timeoutMs: number;
}

// ----- LiteLLM request/response shapes (only the fields we use) -----

export interface CreateUserInput {
  user_id: string;
  user_alias?: string;
  user_email?: string;
  max_budget?: number;
  budget_duration?: string;
  models?: string[];
  metadata?: Record<string, unknown>;
}

export interface LiteLlmUserInfo {
  user_id?: string;
  user_alias?: string;
  max_budget?: number | null;
  budget_duration?: string | null;
  spend?: number;
  models?: string[] | null;
}

export interface GenerateKeyInput {
  user_id: string;
  key_alias?: string;
  models?: string[];
  max_budget?: number;
  budget_duration?: string;
  metadata?: Record<string, unknown>;
  tpm_limit?: number;
  rpm_limit?: number;
  duration?: string;
}

export interface GeneratedKey {
  /** Plaintext virtual key (sk-...). Returned ONLY here; never again retrievable. */
  key: string;
  key_name?: string;
  expires?: string | null;
  user_id?: string;
  token?: string;
}

export interface KeyInfo {
  token?: string;
  spend?: number;
  max_budget?: number | null;
  models?: string[] | null;
  expires?: string | null;
  key_name?: string;
  user_id?: string;
}

export interface SpendLogEntry {
  request_id?: string;
  call_type?: string;
  api_key?: string;
  model?: string;
  spend?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  startTime?: string;
  endTime?: string;
  metadata?: Record<string, unknown>;
}

export interface SpendReportEntry {
  group_by_day?: string;
  spend?: number;
  total_tokens?: number;
  [k: string]: unknown;
}

export interface ListModelsResponse {
  data?: Array<{ id: string; object?: string; owned_by?: string }>;
}

// ----- helpers -----

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export function createLitellmClient(opts: LitellmClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const masterKey = opts.masterKey;
  const timeoutMs = opts.timeoutMs;

  /**
   * Core request. Throws mapped HttpErrors; never resolves on a non-2xx that
   * originates from LiteLLM. `method` defaults to POST because several LiteLLM
   * mutating endpoints (notably /key/delete, /model/delete) are POST, not DELETE.
   *
   * Idempotent GETs are retried on transient network failures (the request never
   * reached LiteLLM, so retrying can't double-apply a side effect). Mutating
   * calls are NOT retried — a /key/generate retry could mint a duplicate key.
   */
  async function request<T>(
    path: string,
    init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Record<string, string | number | undefined | null>; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? "POST";
    const retryable = method === "GET";
    const attempts = retryable ? 3 : 1; // 1 try + 2 retries for GETs.
    const backoffMs = [200, 800];
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await singleRequest<T>(path, init);
      } catch (err) {
        lastErr = err;
        // Only retry on network-level unreachable errors (never on mapped
        // business errors from LiteLLM — those mean the request landed).
        const isUnreachable = err instanceof HttpError && err.code === "llm_unreachable";
        if (!retryable || !isUnreachable || attempt === attempts - 1) throw err;
        await sleep(backoffMs[attempt] ?? 800);
      }
    }
    throw lastErr;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function singleRequest<T>(
    path: string,
    init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Record<string, string | number | undefined | null>; body?: unknown },
  ): Promise<T> {
    const url = `${base}${path}${buildQuery(init.query ?? {})}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "POST",
        headers: {
          Authorization: `Bearer ${masterKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpError(503, "llm_timeout", `LiteLLM request timed out after ${timeoutMs}ms.`);
      }
      throw new HttpError(503, "llm_unreachable", `Cannot reach LiteLLM at ${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    // LiteLLM always returns JSON; parse defensively.
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (res.ok) return parsed as T;

    // Map non-2xx to platform errors.
    throw mapLitellmError(res.status, parsed, path);
  }

  return {
    /** Liveness probe (GET /health/liveliness). */
    async health(): Promise<boolean> {
      try {
        await request<{ status?: string }>("/health/liveliness", { method: "GET" });
        return true;
      } catch (err) {
        logger.debug({ err }, "litellm health check failed");
        return false;
      }
    },

    // ----- users -----
    async createUser(input: CreateUserInput): Promise<unknown> {
      return request("/user/new", { body: input });
    },
    async updateUser(input: { user_id: string } & Partial<CreateUserInput>): Promise<unknown> {
      return request("/user/update", { body: input });
    },
    async getUserInfo(user_id: string): Promise<LiteLlmUserInfo | null> {
      const data = await request<{ user_info?: LiteLlmUserInfo | LiteLlmUserInfo[] } | LiteLlmUserInfo | LiteLlmUserInfo[]>(
        "/user/info",
        { method: "GET", query: { user_id } },
      );
      // LiteLLM wraps info in { user_info: [...] } in some versions; normalize.
      if (Array.isArray(data)) return data[0] ?? null;
      if (data && Array.isArray((data as { user_info?: unknown }).user_info)) {
        const arr = (data as { user_info: LiteLlmUserInfo[] }).user_info;
        return arr[0] ?? null;
      }
      if (data && !Array.isArray(data) && typeof data === "object" && "user_info" in data) {
        const ui = (data as { user_info: LiteLlmUserInfo }).user_info;
        return Array.isArray(ui) ? ui[0] ?? null : ui;
      }
      return (data as LiteLlmUserInfo) ?? null;
    },
    async deleteUser(user_ids: string[]): Promise<unknown> {
      return request("/user/delete", { body: { user_ids } });
    },

    // ----- virtual keys -----
    async generateKey(input: GenerateKeyInput): Promise<GeneratedKey> {
      const data = await request<GeneratedKey & { _is_none?: boolean }>("/key/generate", { body: input });
      if (!data || typeof data !== "object" || typeof (data as GeneratedKey).key !== "string") {
        throw new HttpError(502, "llm_bad_response", "LiteLLM /key/generate did not return a key string.", data);
      }
      return data;
    },
    async getKeyInfo(key: string): Promise<{ key: string; info: KeyInfo } | null> {
      const data = await request<{ key: string; info: KeyInfo } | null>("/key/info", { method: "GET", query: { key } });
      return data ?? null;
    },
    async listKeys(query: { user_id?: string; team_id?: string } = {}): Promise<KeyInfo[]> {
      const data = await request<{ keys?: KeyInfo[] } | KeyInfo[]>("/key/list", { method: "GET", query });
      if (Array.isArray(data)) return data;
      return data?.keys ?? [];
    },
    async updateKey(input: { key: string } & Partial<GenerateKeyInput>): Promise<unknown> {
      return request("/key/update", { body: input });
    },
    /** NOTE: /key/delete is POST in LiteLLM (no DELETE verb). */
    async deleteKey(keys: string[]): Promise<{ deleted_keys: string[] }> {
      return request("/key/delete", { body: { keys } });
    },
    async blockKey(key: string): Promise<{ blocked: boolean }> {
      return request("/key/block", { body: { key } });
    },
    async unblockKey(key: string): Promise<{ blocked: boolean }> {
      return request("/key/unblock", { body: { key } });
    },

    // ----- models -----
    /** OpenAI-compatible model list (the list clients hit directly). */
    async listModels(): Promise<Array<{ id: string; object?: string; owned_by?: string }>> {
      const data = await request<ListModelsResponse>("/v1/models", { method: "GET" });
      return data?.data ?? [];
    },

    // ----- spend / usage -----
    async getSpendLogs(query: { start_date: string; end_date: string; user_id?: string; api_key?: string }): Promise<SpendLogEntry[]> {
      const data = await request<SpendLogEntry[] | { data?: SpendLogEntry[] }>("/spend/logs", { method: "GET", query });
      if (Array.isArray(data)) return data;
      return data?.data ?? [];
    },
    async getSpendReport(query: {
      start_date: string;
      end_date: string;
      group_by?: string;
      internal_user_id?: string;
      api_key?: string;
    }): Promise<SpendReportEntry[]> {
      const data = await request<SpendReportEntry[] | { data?: SpendReportEntry[] }>("/global/spend/report", {
        method: "GET",
        query,
      });
      if (Array.isArray(data)) return data;
      return data?.data ?? [];
    },
  };
}

export type LitellmClient = ReturnType<typeof createLitellmClient>;

/**
 * Translate a non-2xx LiteLLM response into the platform's HttpError hierarchy.
 * Surfaced error bodies carry the original LiteLLM payload under `details`.
 *
 * Budget-exhaustion detection is deliberately broad: LiteLLM signals it in
 * several inconsistent places depending on the failing layer —
 *   { error: { type: "budget_exceeded", ... } }      (OpenAI-style body)
 *   { detail: "ExceededTokenBudget: Current ..." }   (key-level guard)
 *   { error: { message: "ExceededBudget: User=... over budget" } } (user-level)
 * so we look at structured fields first, then scan the concatenated text.
 */
function mapLitellmError(status: number, body: unknown, path: string): HttpError {
  const detail = body;

  // Gather every textual hint LiteLLM might carry, structured first.
  const hints: string[] = [];
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.detail === "string") hints.push(b.detail);
    const err = b.error as Record<string, unknown> | undefined;
    if (err) {
      if (typeof err.type === "string") hints.push(err.type);
      if (typeof err.message === "string") hints.push(err.message);
      if (typeof err.code === "string") hints.push(err.code);
    }
  } else if (typeof body === "string") {
    hints.push(body);
  }
  const haystack = hints.join(" \n ").toLowerCase();

  // Budget signals across LiteLLM's response variants.
  const isBudget =
    haystack.includes("budget_exceeded") ||
    haystack.includes("exceededbudget") ||
    haystack.includes("exceeded budget") ||
    haystack.includes("max budget") ||
    haystack.includes("over budget") ||
    haystack.includes("exceededtokenbudget");

  // Prefer the first human-readable hint for the message.
  const asStr = hints[0] ?? "";

  if (isBudget) {
    return new QuotaExceededError(`LLM budget exceeded: ${asStr || path}`, detail);
  }
  if (status === 429) {
    return new RateLimitError(`LiteLLM rate limit hit at ${path}: ${asStr || "too many requests"}`, detail);
  }
  if (status === 401 || status === 403) {
    return new UnauthorizedError(`LiteLLM rejected credentials at ${path}. Check LITELLM_MASTER_KEY.`);
  }
  if (status === 404) {
    return new NotFoundError("LiteLLM resource", path);
  }
  if (status >= 400 && status < 500) {
    return new BadRequestError(`LiteLLM rejected request at ${path}: ${asStr || status}`, detail);
  }
  return new HttpError(502, "llm_error", `LiteLLM returned ${status} at ${path}: ${asStr || "upstream error"}`, detail);
}

/** Whether LLM integration is wired up given the current config. */
export function isLitellmConfigured(cfg: {
  enabled: boolean;
  litellm: { masterKey?: string };
}): boolean {
  return cfg.enabled && !!cfg.litellm.masterKey;
}
