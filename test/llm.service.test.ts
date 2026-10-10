/**
 * LLM service behavior with a mocked LiteLLM client and a real sqlite db.
 *
 * Covers grantAccess (create + idempotent + re-grant after revoke),
 * updateBudget, revokeAccess, revealMyKey/revokeMyKey owner scoping, and the
 * gateway failure path (grantAccess rolls back locally on createUser error).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestApp, teardownTestApp, createUserAndLogin, type TestContext } from "./helper.ts";
import { createLlmService, type LlmService } from "../src/services/llm.service.ts";
import type { LlmGatewayClient, GeneratedKey } from "../src/services/agentgateway.client.ts";
import { HttpError, NotFoundError } from "../src/utils/errors.ts";
import { encrypt } from "../src/utils/crypto.ts";

const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * Build a LiteLLM client mock whose methods are vi.fn stubs the test controls.
 * Kept as a plain MockMethods record (not intersected with LitellmClient, since
 * concrete method signatures would shadow the index signature) and cast to the
 * real interface only at the createLlmService call site.
 */
type MockMethods = Record<string, ReturnType<typeof vi.fn>>;

function mockLitellmClient(overrides: Partial<MockMethods> = {}): MockMethods {
  const base: MockMethods = {
    health: vi.fn().mockResolvedValue(true),
    getUserInfo: vi.fn().mockResolvedValue({ user_id: "x", spend: 0 }),
    generateKey: vi.fn().mockResolvedValue({ key: "sk-virt-default", key_name: "k-default" } satisfies GeneratedKey),
    deleteKey: vi.fn().mockResolvedValue(undefined),
    putKeyResource: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([{ id: "gpt-4o" }, { id: "claude-sonnet" }]),
    getSpendLogs: vi.fn().mockResolvedValue([]),
    getSpendReport: vi.fn().mockResolvedValue([]),
  };
  return { ...base, ...overrides } as MockMethods;
}

describe("llm service", () => {
  let ctx: TestContext;
  let adminId: number;
  let userId: number;
  let client: ReturnType<typeof mockLitellmClient>;
  let svc: LlmService;

  beforeEach(async () => {
    ctx = await setupTestApp();
    // Need a platform user to grant access to. Create one via the admin API.
    await createUserAndLogin(ctx, "llm-target");
    const userRow = await ctx.db.get<{ id: number }>("SELECT id FROM users WHERE username = ?", "llm-target");
    userId = userRow!.id;
    const adminRow = await ctx.db.get<{ id: number }>("SELECT id FROM users WHERE username = ?", "admin");
    adminId = adminRow!.id;

    client = mockLitellmClient();
    svc = createLlmService(ctx.db, client as unknown as LlmGatewayClient, ENC_KEY, {
      publicBaseUrl: "http://litellm:4000",
    });
  });

  afterEach(async () => {
    await teardownTestApp(ctx);
    vi.restoreAllMocks();
  });

  it("grantAccess records the binding and mints a gateway key (stored encrypted)", async () => {
    client.generateKey.mockResolvedValue({ key: "sk-virt-AAA", key_name: "res-1" });

    const out = await svc.grantAccess({
      platformUserId: userId,
      maxBudget: 10,
      budgetDuration: "1d",
      models: ["gpt-4o"],
      defaultKeyName: "k1",
      grantedBy: adminId,
    });

    expect(out.binding.litellm_user_id).toBe(`litellm_user_${userId}`);
    expect(out.binding.username).toBe("llm-target");
    expect(out.key.plaintext).toBe("sk-virt-AAA");
    // Gateway calls: no user object exists — the key resource carries owner metadata.
    expect(client.generateKey).toHaveBeenCalledWith(expect.objectContaining({ user_id: `litellm_user_${userId}`, key_alias: "k1", max_budget: 10 }));

    // The key is stored encrypted (not plaintext) in the DB.
    const row = await ctx.db.get<{ encrypted_key: string; key_prefix: string; name: string }>(
      "SELECT encrypted_key, key_prefix, name FROM llm_virtual_keys WHERE user_id = ?",
      userId,
    );
    expect(row!.name).toBe("k1");
    expect(row!.key_prefix).toBe("sk-virt-AAA".slice(0, 12));
    expect(row!.encrypted_key).not.toContain("sk-virt-AAA");
    expect(encrypt("x", ENC_KEY)).toBeTruthy(); // sanity: enc key works
  });

  it("grantAccess is idempotent on an existing active binding (updates instead of recreating)", async () => {
    // First grant.
    await svc.grantAccess({ platformUserId: userId, maxBudget: 5, budgetDuration: "1d", grantedBy: adminId });
    client.putKeyResource.mockClear();

    // Second grant with a different budget.
    const out = await svc.grantAccess({ platformUserId: userId, maxBudget: 50, budgetDuration: "7d", grantedBy: adminId });

    // Budget change mirrors onto the user's active key resources.
    expect(client.putKeyResource).toHaveBeenCalledWith(
      "k-default",
      expect.objectContaining({ owner: `litellm_user_${userId}`, maxBudget: 50, budgetDuration: "7d" }),
    );
    expect(out.binding.max_budget).toBe(50);
  });

  it("grantAccess on a revoked binding deletes the stale key resource and re-issues", async () => {
    await svc.grantAccess({ platformUserId: userId, maxBudget: 5, grantedBy: adminId });
    await svc.revokeAccess(userId);
    client.deleteKey.mockClear();
    client.generateKey.mockClear();

    await svc.grantAccess({ platformUserId: userId, maxBudget: 20, grantedBy: adminId });

    expect(client.deleteKey).toHaveBeenCalledWith(["k-default"]);
    expect(client.generateKey).toHaveBeenCalledWith(expect.objectContaining({ user_id: `litellm_user_${userId}` }));
  });

  it("grantAccess on a non-existent platform user throws NotFound", async () => {
    await expect(svc.grantAccess({ platformUserId: 999999, maxBudget: 5, grantedBy: adminId })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("updateBudget syncs to LiteLLM and the local row", async () => {
    await svc.grantAccess({ platformUserId: userId, maxBudget: 5, budgetDuration: "1d", models: ["gpt-4o"], grantedBy: adminId });
    client.putKeyResource.mockClear();

    const binding = await svc.updateBudget(userId, { maxBudget: 99, models: ["gpt-4o", "claude-sonnet"] }, adminId);

    expect(client.putKeyResource).toHaveBeenCalledWith(
      "k-default",
      expect.objectContaining({ owner: `litellm_user_${userId}`, maxBudget: 99, models: ["gpt-4o", "claude-sonnet"] }),
    );
    expect(binding.max_budget).toBe(99);
  });

  it("revokeAccess soft-revokes binding + keys and deletes the key resources", async () => {
    await svc.grantAccess({ platformUserId: userId, maxBudget: 5, grantedBy: adminId });
    client.deleteKey.mockClear();

    await svc.revokeAccess(userId);

    expect(client.deleteKey).toHaveBeenCalledWith(["k-default"]);
    const binding = await ctx.db.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM llm_user_bindings WHERE platform_user_id = ?",
      userId,
    );
    expect(binding!.revoked_at).not.toBeNull();
    const keys = await ctx.db.all<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM llm_virtual_keys WHERE user_id = ?",
      userId,
    );
    expect(keys.every((k) => k.revoked_at !== null)).toBe(true);
  });

  it("revokeAccess tolerates a 404 from the gateway (resource already gone)", async () => {
    await svc.grantAccess({ platformUserId: userId, maxBudget: 5, grantedBy: adminId });
    client.deleteKey.mockRejectedValue(new HttpError(404, "not_found", "gone"));
    await expect(svc.revokeAccess(userId)).resolves.toBeUndefined();
  });

  it("revokeAccess re-throws non-404 gateway errors", async () => {
    await svc.grantAccess({ platformUserId: userId, maxBudget: 5, grantedBy: adminId });
    client.deleteKey.mockRejectedValue(new HttpError(500, "llm_error", "boom"));
    await expect(svc.revokeAccess(userId)).rejects.toMatchObject({ status: 500 });
  });

  it("revealMyKey returns the stored plaintext and is owner-scoped", async () => {
    const out = await svc.grantAccess({ platformUserId: userId, maxBudget: 5, grantedBy: adminId });
    client.generateKey.mockResolvedValue({ key: out.key.plaintext, key_name: "k" });

    const revealed = await svc.revealMyKey(out.key.id, userId);
    expect(revealed.plaintext).toBe(out.key.plaintext);

    // A different user cannot reveal this key.
    await createUserAndLogin(ctx, "llm-other");
    const otherRow = await ctx.db.get<{ id: number }>("SELECT id FROM users WHERE username = ?", "llm-other");
    await expect(svc.revealMyKey(out.key.id, otherRow!.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("revokeMyKey soft-deletes locally and deletes the gateway resource by id", async () => {
    const out = await svc.grantAccess({ platformUserId: userId, maxBudget: 5, grantedBy: adminId });
    client.deleteKey.mockClear();

    await svc.revokeMyKey(out.key.id, userId);

    expect(client.deleteKey).toHaveBeenCalledWith(["k-default"]);
    const row = await ctx.db.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM llm_virtual_keys WHERE id = ?",
      out.key.id,
    );
    expect(row!.revoked_at).not.toBeNull();
  });

  it("getMyStatus returns null binding for a user with no access", async () => {
    const status = await svc.getMyStatus(userId);
    expect(status.binding).toBeNull();
    expect(status.litellm).toBeNull();
  });

  it("getEndpoint returns the configured public base URL", () => {
    expect(svc.getEndpoint().baseUrl).toBe("http://litellm:4000");
  });

  it("listModels proxies the gateway's model list", async () => {
    const models = await svc.listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "claude-sonnet"]);
  });

  it("binding.models is decoded to a real array (sqlite stores JSON as text)", async () => {
    // grant with a models list, then read it back through listBindings / getMyStatus;
    // the JSON column must be decoded, not returned as a string (regression: the
    // admin/user pages called models.join() and crashed on sqlite).
    await svc.grantAccess({
      platformUserId: userId,
      maxBudget: 5,
      models: ["gpt-4o", "claude-sonnet"],
      grantedBy: adminId,
    });

    const bindings = await svc.listBindings();
    const binding = bindings.find((b) => b.platform_user_id === userId);
    expect(Array.isArray(binding!.models)).toBe(true);
    expect(binding!.models).toEqual(["gpt-4o", "claude-sonnet"]);

    const status = await svc.getMyStatus(userId);
    expect(Array.isArray(status.binding?.models)).toBe(true);
    expect(status.binding?.models).toEqual(["gpt-4o", "claude-sonnet"]);

    // And listMyKeys returns models as an array too.
    const keys = await svc.listMyKeys(userId);
    expect(keys.length).toBeGreaterThan(0);
    expect(Array.isArray(keys[0].models)).toBe(true);
  });
});
