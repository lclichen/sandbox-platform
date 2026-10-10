/**
 * agentgateway LLM-gateway client (2026-10 LiteLLM replacement, path b).
 *
 * The platform remains the key authority: it mints random keys, stores the
 * plaintext encrypted locally, and declares only the key's SHA-256 to the
 * gateway (llm.apiKey config resources, admin API). Inference traffic never
 * flows through the platform — clients hit the gateway's public OpenAI-
 * compatible endpoint directly with the platform-issued key.
 *
 * Gateway contract (verified live 2026-10-10, upstream agentgateway):
 *   - PUT  {admin}/api/config/resources/llm.apiKey
 *         body {"resources":[{"value":{keyHash, metadata, allowedModels?, budgets?}}]}
 *         → creates with a server-assigned UUID id (ids are NOT client-chosen;
 *           the response carries it — callers must persist it).
 *         NOTE: metadata key "agentgateway.dev/owner" is server-reserved; use
 *         the plain "owner" field — the default user-attribution CEL reads it
 *         (coalesce(apiKey["agentgateway.dev/owner"], apiKey.user, apiKey.name,
 *         apiKey.owner, ...)) and it lands in the indexed agentgateway_user
 *         request-log column.
 *   - PUT/DELETE {admin}/api/config/resources/llm.apiKey/{id} — update/remove
 *         an existing key resource (404 on unknown id).
 *   - POST {admin}/api/logs/search {timeRange:{from,to},
 *         filters:{attributes:{"agentgateway.user": owner}}, limit}
 *         → camelCase entries: cost, usage.inputTokens/outputTokens/totalTokens,
 *           genAi.requestModel, completedAt, httpStatus, id.
 *   - GET  {admin}/api/config/effective → llm.models[].name +
 *         llm.virtualModels[].name (model catalogue without a data-plane key).
 *
 * Budget semantics vs LiteLLM: budgets are per key resource (USD or Tokens +
 * epoch-aligned rolling window + Block). LiteLLM's user-level shared budget is
 * approximated by applying the binding's budget to every issued key; the
 * "monthly" calendar reset maps to "30d" rolling (documented delta).
 */
import { randomBytes, createHash } from "node:crypto";
import { HttpError } from "../utils/errors.ts";

// ----- shared types (consumed by llm.service.ts / routes; kept litellm-shaped
// so the REST contract with clients does not change in this migration) -----

export interface LiteLlmUserInfo {
  user_id?: string;
  user_alias?: string;
  max_budget?: number | null;
  budget_duration?: string | null;
  spend?: number;
  models?: string[] | null;
}

export interface GeneratedKey {
  /** Plaintext gateway key (sk-agw-...). Returned ONLY here; never again retrievable. */
  key: string;
  /** Gateway resource id (server-assigned UUID) — persist for update/delete. */
  key_name?: string;
  expires?: string | null;
  user_id?: string;
  token?: string;
}

export interface SpendLogEntry {
  request_id?: string;
  call_type?: string;
  model?: string;
  spend?: number;
  tokens?: number;
  created_at?: string;
  [k: string]: unknown;
}

export interface SpendReportEntry {
  group_by_day?: string;
  spend?: number;
  total_tokens?: number;
  [k: string]: unknown;
}

export interface SpendQuery {
  start_date: string;
  end_date: string;
  /** Platform owner id (the "u<id>" string the platform mints into metadata.owner). */
  user_id?: string;
}

export interface GatewayClientOptions {
  /** Admin API base (e.g. http://127.0.0.1:15000). */
  adminUrl: string;
  /** Data-plane base URL, used only for model listing fallback and docs. */
  publicBaseUrl: string;
  timeoutMs: number;
}

export interface LlmGatewayClient {
  health(): Promise<boolean>;
  /** Mint a key and declare it to the gateway. Returns plaintext + resource id. */
  generateKey(input: {
    user_id: string;
    key_alias?: string;
    models?: string[];
    max_budget?: number;
    budget_duration?: string;
  }): Promise<GeneratedKey>;
  /** Remove key resources by id (404 tolerated). */
  deleteKey(resourceIds: string[]): Promise<void>;
  /** Rewrite an existing key resource from platform-owned state (the admin
   *  API has no single-resource GET, so the service supplies the full value
   *  from its own rows: key hash, owner, models, budget). */
  putKeyResource(id: string, value: {
    keyHash: string;
    owner: string;
    models?: string[] | null;
    maxBudget?: number | null;
    budgetDuration?: string | null;
  }): Promise<void>;
  /** Spend + usage for an owner (aggregated from request logs). */
  getUserInfo(owner: string): Promise<LiteLlmUserInfo | null>;
  getSpendLogs(query: SpendQuery): Promise<SpendLogEntry[]>;
  getSpendReport(query: SpendQuery): Promise<SpendReportEntry[]>;
  listModels(): Promise<Array<{ id: string; object?: string; owned_by?: string }>>;
}

const RESOURCE_KIND = "llm.apiKey";
const OWNER_ATTR = "agentgateway.user";

/** Map a litellm budget_duration ("monthly" | "7d" | ...) to a rolling window. */
function rollingWindow(duration: string | null | undefined): string {
  if (!duration) return "30d";
  if (duration === "monthly" || duration === "30d" || duration === "1mo") return "30d";
  return duration;
}

export function createLlmGatewayClient(opts: GatewayClientOptions): LlmGatewayClient {
  const admin = opts.adminUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs;

  async function request<T>(
    path: string,
    init: { method?: "GET" | "PUT" | "DELETE" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${admin}${path}`, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new HttpError(502, "LLM_UNREACHABLE", `agentgateway admin API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 404 from delete/update of a missing resource is a normal race; callers
      // decide, so mark it distinctly.
      if (res.status === 404) {
        throw new HttpError(404, "LLM_GATEWAY_NOT_FOUND", text || `agentgateway: ${path} not found`);
      }
      const budget = res.status === 422 || /budget/i.test(text);
      throw new HttpError(
        budget ? 422 : res.status === 429 ? 429 : 502,
        budget ? "LLM_BUDGET_EXCEEDED" : res.status === 429 ? "LLM_RATE_LIMITED" : "LLM_GATEWAY_ERROR",
        `agentgateway ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  interface UiResource {
    id: string;
    value: {
      key?: string;
      keyHash?: string;
      metadata?: Record<string, unknown>;
      allowedModels?: string[];
      budgets?: Array<Record<string, unknown>>;
      [k: string]: unknown;
    };
  }

  interface LogEntry {
    id?: string;
    completedAt?: string;
    httpStatus?: number;
    cost?: number | null;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    genAi?: { requestModel?: string; responseModel?: string };
    [k: string]: unknown;
  }

  async function searchLogs(owner: string, query?: SpendQuery): Promise<LogEntry[]> {
    const body: Record<string, unknown> = {
      limit: 1000,
      filters: { attributes: { [OWNER_ATTR]: owner } },
    };
    if (query) {
      body.timeRange = { from: query.start_date, to: query.end_date };
    }
    const res = await request<{ logs?: LogEntry[] }>("/api/logs/search", { method: "POST", body });
    return res.logs ?? [];
  }

  return {
    async health(): Promise<boolean> {
      try {
        await request("/api/config/effective");
        return true;
      } catch {
        return false;
      }
    },

    async generateKey(input): Promise<GeneratedKey> {
      const plaintext = `sk-agw-${randomBytes(24).toString("hex")}`;
      const keyHash = `sha256:${createHash("sha256").update(plaintext).digest("hex")}`;
      const value: Record<string, unknown> = {
        keyHash,
        metadata: { name: input.user_id, owner: input.user_id },
      };
      if (input.models && input.models.length > 0) value.allowedModels = input.models;
      if (input.max_budget !== undefined && input.max_budget > 0) {
        value.budgets = [
          {
            name: input.user_id,
            limit: { unit: "USD", amount: input.max_budget },
            window: { rolling: rollingWindow(input.budget_duration) },
            onBudgetExceeded: "Block",
          },
        ];
      }
      const res = await request<{ resources?: UiResource[] }>("/api/config/resources/llm.apiKey", {
        method: "PUT",
        body: { resources: [{ value }] },
      });
      const id = res.resources?.[0]?.id;
      if (!id) {
        throw new HttpError(502, "LLM_GATEWAY_ERROR", "agentgateway key upsert returned no resource id");
      }
      return { key: plaintext, key_name: id, user_id: input.user_id };
    },

    async deleteKey(resourceIds): Promise<void> {
      for (const id of resourceIds) {
        if (!id) continue;
        await request(`/api/config/resources/${RESOURCE_KIND}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }).catch((err) => {
          if (err instanceof HttpError && err.status === 404) return;
          throw err;
        });
      }
    },

    async putKeyResource(id, value): Promise<void> {
      const next: Record<string, unknown> = {
        keyHash: value.keyHash,
        metadata: { name: value.owner, owner: value.owner },
      };
      if (value.models && value.models.length > 0) next.allowedModels = value.models;
      if (value.maxBudget != null && value.maxBudget > 0) {
        next.budgets = [
          {
            name: value.owner,
            limit: { unit: "USD", amount: value.maxBudget },
            window: { rolling: rollingWindow(value.budgetDuration) },
            onBudgetExceeded: "Block",
          },
        ];
      }
      await request(`/api/config/resources/${RESOURCE_KIND}/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { value: next },
      }).catch((err) => {
        if (err instanceof HttpError && err.status === 404) return; // resource already gone
        throw err;
      });
    },

    async getUserInfo(owner) {
      const logs = await searchLogs(owner);
      if (logs.length === 0) return { user_id: owner, spend: 0, max_budget: null, budget_duration: null, models: null };
      const spend = logs.reduce((sum, l) => sum + (l.cost ?? 0), 0);
      return { user_id: owner, spend, max_budget: null, budget_duration: null, models: null };
    },

    async getSpendLogs(query) {
      if (!query.user_id) return [];
      const logs = await searchLogs(query.user_id, query);
      return logs.map((l) => ({
        request_id: l.id,
        call_type: "chat",
        model: l.genAi?.requestModel,
        spend: l.cost ?? 0,
        tokens: l.usage?.totalTokens ?? 0,
        created_at: l.completedAt,
      }));
    },

    async getSpendReport(query) {
      if (!query.user_id) return [];
      const logs = await searchLogs(query.user_id, query);
      const byDay = new Map<string, { spend: number; total_tokens: number }>();
      for (const l of logs) {
        const day = (l.completedAt ?? "").slice(0, 10);
        const agg = byDay.get(day) ?? { spend: 0, total_tokens: 0 };
        agg.spend += l.cost ?? 0;
        agg.total_tokens += l.usage?.totalTokens ?? 0;
        byDay.set(day, agg);
      }
      return [...byDay.entries()].map(([day, agg]) => ({
        group_by_day: day,
        spend: agg.spend,
        total_tokens: agg.total_tokens,
      }));
    },

    async listModels() {
      const cfg = await request<{
        llm?: { models?: Array<{ name?: string }>; virtualModels?: Array<{ name?: string }> };
      }>("/api/config/effective");
      const names = [
        ...(cfg.llm?.models ?? []).map((m) => m.name).filter((n): n is string => !!n),
        ...(cfg.llm?.virtualModels ?? []).map((m) => m.name).filter((n): n is string => !!n),
      ];
      return names.map((id) => ({ id, object: "model", owned_by: "agentgateway" }));
    },
  };
}

/** Config gate: the gateway needs no master key (admin API is network-scoped);
 * enabled + adminUrl + a valid encryption key is enough to wire the client. */
export function isGatewayConfigured(input: { enabled: boolean; adminUrl?: string }): boolean {
  return input.enabled && !!input.adminUrl && input.adminUrl.length > 0;
}
