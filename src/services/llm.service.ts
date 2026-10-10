/**
 * LLM integration service: bridges platform users with the agentgateway LLM
 * gateway (2026-10 LiteLLM replacement, path b — the platform is the key
 * authority; the gateway authenticates, enforces per-key budgets/model
 * allowlists, and attributes requests per owner in its request logs).
 *
 * Responsibilities (management-proxy model — unchanged):
 *   - Admin grants LLM access to a platform user → records the binding, mints
 *     a gateway key resource, stores the binding + encrypted key.
 *   - Admin updates budgets / revokes access → mirrored onto the user's key
 *     resources via the admin API.
 *   - Users self-serve: list/revoke/reveal their own keys, view usage (from
 *     gateway request logs), models, and the endpoint to drive LLM traffic
 *     directly.
 *
 * Budget enforcement lives in the gateway (per-key USD budget + rolling
 * window + Block); LiteLLM's user-level shared budget is approximated by
 * applying the binding budget to each issued key, and "monthly" maps to a
 * 30d rolling window. The mirrored columns here are for display and re-issue.
 * DB column names keep their historical litellm_* spelling to avoid a
 * migration; litellm_user_id holds the owner id, litellm_key_id the gateway
 * resource id, litellm_key_hash the platform's sha256 of the plaintext.
 */
import type { Database } from "../db/driver.ts";
import type { DbDialect } from "../config.ts";
import { encodeJson, decodeJson, type SqlValue } from "../db/driver.ts";
import { createUserService } from "./user.service.ts";
import type { LlmGatewayClient, LiteLlmUserInfo, SpendLogEntry, SpendReportEntry } from "./agentgateway.client.ts";
import { encrypt, decrypt, type EncryptionKey } from "../utils/crypto.ts";
import { NotFoundError, ConflictError, BadRequestError, HttpError } from "../utils/errors.ts";
import { createHash } from "node:crypto";

/** Active gateway key resources of a user: resource id + the platform's hash
 *  of the plaintext (enough to rewrite the resource without a gateway GET). */
async function activeKeyResources(
  db: Database,
  platformUserId: number,
): Promise<Array<{ id: string; keyHash: string }>> {
  const rows = await db.all<{ litellm_key_id: string | null; litellm_key_hash: string | null }>(
    "SELECT litellm_key_id, litellm_key_hash FROM llm_virtual_keys WHERE user_id = ? AND revoked_at IS NULL AND litellm_key_id IS NOT NULL",
    platformUserId,
  );
  return rows
    .filter((r) => r.litellm_key_id && r.litellm_key_hash)
    .map((r) => ({ id: r.litellm_key_id!, keyHash: r.litellm_key_hash! }));
}

// ----- row shapes -----

export interface LlmBindingRow {
  id: number;
  platform_user_id: number;
  litellm_user_id: string;
  litellm_alias: string | null;
  max_budget: number;
  budget_duration: string | null;
  models: string[] | null;
  granted_at: string;
  granted_by: number;
  revoked_at: string | null;
}

export interface LlmBindingPublic extends Omit<LlmBindingRow, "litellm_alias"> {
  username: string;
  litellm_alias: string | null;
}

export interface LlmVirtualKeyRow {
  id: number;
  user_id: number;
  litellm_key_hash: string;
  litellm_key_id: string | null;
  key_prefix: string;
  encrypted_key: string;
  name: string;
  models: string[] | null;
  max_budget: number | null;
  budget_duration: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** A key row as returned to clients (never includes the ciphertext/plaintext). */
export interface LlmVirtualKeyPublic {
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

// ----- inputs -----

export interface GrantAccessInput {
  platformUserId: number;
  maxBudget: number;
  budgetDuration?: string | null;
  models?: string[] | null;
  defaultKeyName?: string;
  grantedBy: number;
}

export interface UpdateBudgetInput {
  maxBudget?: number;
  budgetDuration?: string | null;
  models?: string[] | null;
}

export interface UsageRange {
  startDate: string;
  endDate: string;
}

function toKeyPublic(row: LlmVirtualKeyRow): LlmVirtualKeyPublic {
  // Strip the ciphertext; clients never see it.
  const { encrypted_key: _drop, litellm_key_hash: _drop2, ...rest } = row;
  void _drop;
  void _drop2;
  return rest;
}

function litellmUserIdFor(platformUserId: number): string {
  return `litellm_user_${platformUserId}`;
}

function keyPrefix(plaintext: string): string {
  // Show the first 12 chars; LiteLLM keys are sk-... so this preserves recognizability.
  return plaintext.slice(0, 12);
}

function hashForLookup(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function createLlmService(db: Database, gateway: LlmGatewayClient, encryptionKey: EncryptionKey, opts: { publicBaseUrl: string }) {
  const users = createUserService(db);
  const dialect: DbDialect = db.dialect;
  const publicBaseUrl = opts.publicBaseUrl;

  /**
   * encodeJson returns unknown (it's dialect-polymorphic); narrow to SqlValue
   * for the parameterized query helpers, which only accept primitive DB values.
   */
  function jsonParam(value: unknown): SqlValue {
    return encodeJson(value, dialect) as SqlValue;
  }

  /**
   * Public projection of a binding. `models` is a JSON column (TEXT on sqlite,
   * JSONB on pg); decode it to a JS array here so callers can `.join()` /
   * iterate without hitting "models.join is not a function" on sqlite.
   */
  function toBindingPublic(row: LlmBindingRow, username: string): LlmBindingPublic {
    return { ...row, username, models: decodeJson<string[]>(row.models, dialect) };
  }

  // ---------- admin: bindings ----------

  async function getBindingRow(platformUserId: number): Promise<LlmBindingRow | null> {
    return db.get<LlmBindingRow>("SELECT * FROM llm_user_bindings WHERE platform_user_id = ?", platformUserId);
  }

  async function listBindings(): Promise<LlmBindingPublic[]> {
    const rows = await db.all<LlmBindingRow & { username: string }>(
      `SELECT b.*, u.username
         FROM llm_user_bindings b
         JOIN users u ON u.id = b.platform_user_id
        ORDER BY b.id`,
    );
    return rows.map((r) => toBindingPublic(r, r.username));
  }

  async function getBinding(platformUserId: number): Promise<LlmBindingPublic | null> {
    const row = await getBindingRow(platformUserId);
    if (!row) return null;
    const u = await users.getById(platformUserId);
    return toBindingPublic(row, u?.username ?? "");
  }

  /**
   * Grant LLM access to a platform user. Idempotent on an existing active
   * binding (updates budget/models instead of re-creating). On a revoked
   * binding, the old LiteLLM user is deleted first and a fresh one is created.
   * Returns the initial key's plaintext exactly once.
   */
  async function grantAccess(input: GrantAccessInput): Promise<{ binding: LlmBindingPublic; key: { plaintext: string; id: number } }> {
    const user = await users.getById(input.platformUserId);
    if (!user) throw new NotFoundError("User", input.platformUserId);
    if (user.status !== "active") throw new BadRequestError(`User ${user.username} is not active`);

    const existing = await getBindingRow(input.platformUserId);
    const litellmUserId = litellmUserIdFor(input.platformUserId);
    const alias = user.username;

    if (existing && !existing.revoked_at) {
      // Idempotent: update budget/models locally and mirror onto the user's
      // active gateway key resources.
      const resources = await activeKeyResources(db, input.platformUserId);
      await Promise.all(resources.map((r) => gateway.putKeyResource(r.id, {
        keyHash: r.keyHash,
        owner: litellmUserId,
        models: input.models ?? null,
        maxBudget: input.maxBudget,
        budgetDuration: input.budgetDuration ?? null,
      }))).catch(() => {
        /* best-effort mirror; the local binding stays the source of truth */
      });
      await db.run(
        `UPDATE llm_user_bindings
            SET max_budget = ?, budget_duration = ?, models = ?, granted_by = ?
          WHERE platform_user_id = ?`,
        input.maxBudget,
        input.budgetDuration ?? null,
        jsonParam(input.models ?? null),
        input.grantedBy,
        input.platformUserId,
      );
      const refreshed = await getBindingRow(input.platformUserId);
      const key = await issueKey({
        platformUserId: input.platformUserId,
        name: input.defaultKeyName ?? "default",
        models: input.models ?? null,
        maxBudget: input.maxBudget,
        budgetDuration: input.budgetDuration ?? null,
      });
      return { binding: toBindingPublic(refreshed!, user.username), key };
    }

    if (existing && existing.revoked_at) {
      // Clean up any key resources the old binding still holds before re-granting
      // (rows are soft-revoked by revokeAccess, so scan regardless of state).
      const stale = await db.all<{ litellm_key_id: string | null }>(
        "SELECT litellm_key_id FROM llm_virtual_keys WHERE user_id = ? AND litellm_key_id IS NOT NULL",
        input.platformUserId,
      );
      await gateway.deleteKey(stale.map((r) => r.litellm_key_id!).filter(Boolean)).catch(() => {
        /* best-effort: they may already be gone */
      });
      await db.run("DELETE FROM llm_user_bindings WHERE platform_user_id = ?", input.platformUserId);
    }

    // Record the binding locally (the gateway has no user object — the owner
    // id rides each key resource's metadata and its per-request attribution).
    await db.run(
      `INSERT INTO llm_user_bindings
          (platform_user_id, litellm_user_id, litellm_alias, max_budget, budget_duration, models, granted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.platformUserId,
      litellmUserId,
      alias,
      input.maxBudget,
      input.budgetDuration ?? null,
      jsonParam(input.models ?? null),
      input.grantedBy,
    );

    const key = await issueKey({
      platformUserId: input.platformUserId,
      name: input.defaultKeyName ?? "default",
      models: input.models ?? null,
      maxBudget: input.maxBudget,
      budgetDuration: input.budgetDuration ?? null,
    });

    const binding = await getBindingRow(input.platformUserId);
    return { binding: toBindingPublic(binding!, user.username), key };
  }

  async function updateBudget(platformUserId: number, patch: UpdateBudgetInput, grantedBy: number): Promise<LlmBindingPublic> {
    const existing = await getBindingRow(platformUserId);
    if (!existing || existing.revoked_at) throw new NotFoundError("LLM binding", platformUserId);
    const user = await users.getById(platformUserId);
    if (!user) throw new NotFoundError("User", platformUserId);

    const nextBudget = patch.maxBudget ?? existing.max_budget;
    const nextDuration = patch.budgetDuration !== undefined ? patch.budgetDuration : existing.budget_duration;
    const nextModels = patch.models !== undefined ? patch.models : existing.models;

    const resources = await activeKeyResources(db, platformUserId);
    await Promise.all(resources.map((r) => gateway.putKeyResource(r.id, {
      keyHash: r.keyHash,
      owner: existing.litellm_user_id,
      models: nextModels,
      maxBudget: nextBudget,
      budgetDuration: nextDuration,
    }))).catch(() => {
      /* best-effort mirror; the local binding stays the source of truth */
    });
    await db.run(
      `UPDATE llm_user_bindings
          SET max_budget = ?, budget_duration = ?, models = ?, granted_by = ?
        WHERE platform_user_id = ?`,
      nextBudget,
      nextDuration,
      jsonParam(nextModels),
      grantedBy,
      platformUserId,
    );
    const refreshed = await getBindingRow(platformUserId);
    return toBindingPublic(refreshed!, user.username);
  }

  /**
   * Revoke a user's LLM access. Deletes the LiteLLM user (which cascades to its
   * keys on the LiteLLM side) and soft-revokes the local binding + all keys.
   */
  async function revokeAccess(platformUserId: number): Promise<void> {
    const existing = await getBindingRow(platformUserId);
    if (!existing) throw new NotFoundError("LLM binding", platformUserId);

    // Best-effort removal of the user's key resources on the gateway; local
    // state is the source of truth for whether access is "granted", so we
    // revoke locally even if this fails.
    const resources = await activeKeyResources(db, platformUserId);
    await gateway.deleteKey(resources.map((r) => r.id)).catch((err) => {
      // Surface non-404 errors; a missing resource is fine.
      if (err instanceof HttpError && err.status !== 404) throw err;
    });

    await db.tx(async (tx) => {
      await tx.run("UPDATE llm_user_bindings SET revoked_at = CURRENT_TIMESTAMP WHERE platform_user_id = ?", platformUserId);
      await tx.run("UPDATE llm_virtual_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL", platformUserId);
    });
  }

  async function getBindingUsage(platformUserId: number, range: UsageRange): Promise<{ user: LiteLlmUserInfo | null; report: SpendReportEntry[]; logs: SpendLogEntry[] }> {
    const existing = await getBindingRow(platformUserId);
    if (!existing || existing.revoked_at) throw new NotFoundError("LLM binding", platformUserId);
    const [user, report, logs] = await Promise.all([
      gateway.getUserInfo(existing.litellm_user_id),
      gateway.getSpendReport({ start_date: range.startDate, end_date: range.endDate, user_id: existing.litellm_user_id }),
      gateway.getSpendLogs({ start_date: range.startDate, end_date: range.endDate, user_id: existing.litellm_user_id }),
    ]);
    return { user, report, logs };
  }

  // ---------- keys (shared admin + user) ----------

  async function issueKey(input: {
    platformUserId: number;
    name: string;
    models: string[] | null;
    maxBudget: number;
    budgetDuration: string | null;
  }): Promise<{ plaintext: string; id: number }> {
    const binding = await getBindingRow(input.platformUserId);
    if (!binding || binding.revoked_at) throw new NotFoundError("LLM binding", input.platformUserId);
    const generated = await gateway.generateKey({
      user_id: binding.litellm_user_id,
      key_alias: input.name,
      models: input.models ?? undefined,
      max_budget: input.maxBudget,
      budget_duration: input.budgetDuration ?? undefined,
    });
    const plaintext = generated.key;
    const encrypted = encrypt(plaintext, encryptionKey);
    const result = await db.run(
      `INSERT INTO llm_virtual_keys
          (user_id, litellm_key_hash, litellm_key_id, key_prefix, encrypted_key, name, models, max_budget, budget_duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.platformUserId,
      hashForLookup(plaintext),
      generated.key_name ?? null,
      keyPrefix(plaintext),
      encrypted,
      input.name,
      jsonParam(input.models),
      input.maxBudget,
      input.budgetDuration,
    );
    return { plaintext, id: Number(result.lastInsertRowid) };
  }

  async function listKeysForUser(userId: number): Promise<LlmVirtualKeyPublic[]> {
    const rows = await db.all<LlmVirtualKeyRow>(
      "SELECT * FROM llm_virtual_keys WHERE user_id = ? ORDER BY id DESC",
      userId,
    );
    return rows.map((r) => ({ ...toKeyPublic(r), models: decodeJson<string[]>(r.models, dialect) }));
  }

  async function listAllKeys(): Promise<LlmVirtualKeyPublic[]> {
    const rows = await db.all<LlmVirtualKeyRow>("SELECT * FROM llm_virtual_keys ORDER BY id DESC");
    return rows.map((r) => ({ ...toKeyPublic(r), models: decodeJson<string[]>(r.models, dialect) }));
  }

  async function getKeyRow(id: number, userId: number): Promise<LlmVirtualKeyRow | null> {
    return db.get<LlmVirtualKeyRow>("SELECT * FROM llm_virtual_keys WHERE id = ? AND user_id = ?", id, userId);
  }

  async function revokeKey(id: number, userId: number): Promise<void> {
    const row = await getKeyRow(id, userId);
    if (!row) throw new NotFoundError("LLM key", id);
    if (row.revoked_at) return; // idempotent
    // Delete by the stored gateway resource id (legacy rows without one are
    // simply marked revoked locally — their gateway key, if any, is gone with
    // the old deployment).
    if (row.litellm_key_id) {
      await gateway.deleteKey([row.litellm_key_id]).catch((err) => {
        if (err instanceof HttpError && err.status !== 404) throw err;
      });
    }
    await db.run("UPDATE llm_virtual_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  }

  /**
   * Reveal (decrypt) a key's plaintext. Intended for the owning user to copy it
   * into a container. The audit middleware already records the POST; callers
   * should treat this as a sensitive, rate-limited surface.
   */
  async function revealKey(id: number, userId: number): Promise<{ id: number; plaintext: string }> {
    const row = await getKeyRow(id, userId);
    if (!row) throw new NotFoundError("LLM key", id);
    if (row.revoked_at) throw new ConflictError("LLM key has been revoked");
    const plaintext = decrypt(row.encrypted_key, encryptionKey);
    return { id, plaintext };
  }

  // ---------- user self-service ----------

  async function getMyStatus(userId: number): Promise<{ binding: LlmBindingPublic | null; litellm: LiteLlmUserInfo | null }> {
    const binding = await getBinding(userId);
    if (!binding || binding.revoked_at) return { binding: null, litellm: null };
    const info = await gateway.getUserInfo(binding.litellm_user_id);
    return { binding, litellm: info };
  }

  async function getMyUsage(userId: number, range: UsageRange) {
    return getBindingUsage(userId, range);
  }

  function getEndpoint(): { baseUrl: string; instructions: string } {
    return {
      baseUrl: publicBaseUrl,
      instructions:
        "Use this base URL with the OpenAI SDK (Authorization: Bearer <your virtual key>) " +
        "or the Anthropic SDK (x-api-key: <your virtual key>, anthropic-version: 2023-06-01).",
    };
  }

  async function listModels() {
    return gateway.listModels();
  }

  return {
    // admin
    listBindings,
    getBinding,
    grantAccess,
    updateBudget,
    revokeAccess,
    getBindingUsage,
    listAllKeys,
    // user (owner-scoped)
    getMyStatus,
    listMyKeys: listKeysForUser,
    revokeMyKey: revokeKey,
    revealMyKey: revealKey,
    getMyUsage,
    getEndpoint,
    listModels,
  };
}

export type LlmService = ReturnType<typeof createLlmService>;
