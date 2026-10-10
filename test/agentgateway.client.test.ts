/**
 * agentgateway client unit tests (path b): fetch is mocked; the request
 * shapes pinned here were verified live against upstream agentgateway on
 * 2026-10-10 (see src/services/agentgateway.client.ts header).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLlmGatewayClient, isGatewayConfigured } from "../src/services/agentgateway.client.ts";
import { HttpError } from "../src/utils/errors.ts";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function makeClient() {
  return createLlmGatewayClient({
    adminUrl: "http://gw-admin:15000/",
    publicBaseUrl: "http://gw:4000",
    timeoutMs: 5000,
  });
}

describe("generateKey", () => {
  it("declares only the keyHash with owner metadata + budget + allowlist and returns the resource id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { resources: [{ id: "uuid-1", value: {} }] }),
    );
    const out = await makeClient().generateKey({
      user_id: "u7",
      key_alias: "default",
      models: ["TestModel"],
      max_budget: 5,
      budget_duration: "monthly",
    });

    expect(out.key).toMatch(/^sk-agw-[0-9a-f]{48}$/);
    expect(out.key_name).toBe("uuid-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw-admin:15000/api/config/resources/llm.apiKey");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    const value = body.resources[0].value;
    // Only the hash is declared — the gateway never sees the plaintext.
    expect(value.key).toBeUndefined();
    expect(value.keyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Plain "owner" (the agentgateway.dev/ prefix is server-reserved).
    expect(value.metadata).toEqual({ name: "u7", owner: "u7" });
    expect(value.allowedModels).toEqual(["TestModel"]);
    expect(value.budgets[0]).toEqual({
      name: "u7",
      limit: { unit: "USD", amount: 5 },
      window: { rolling: "30d" },
      onBudgetExceeded: "Block",
    });
  });

  it("omits budgets and allowlist when unset", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { resources: [{ id: "uuid-2", value: {} }] }));
    await makeClient().generateKey({ user_id: "u8" });
    const value = JSON.parse(fetchMock.mock.calls[0][1].body).resources[0].value;
    expect(value.budgets).toBeUndefined();
    expect(value.allowedModels).toBeUndefined();
  });
});

describe("deleteKey", () => {
  it("deletes each resource and tolerates 404", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { resources: [] }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(makeClient().deleteKey(["a", "b"])).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("http://gw-admin:15000/api/config/resources/llm.apiKey/a");
    expect(fetchMock.mock.calls[1][0]).toBe("http://gw-admin:15000/api/config/resources/llm.apiKey/b");
  });

  it("re-throws non-404 errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(makeClient().deleteKey(["a"])).rejects.toMatchObject({ status: 502 });
  });
});

describe("putKeyResource", () => {
  it("rewrites the resource from platform-owned state (no GET, no plaintext)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { resources: [] }));
    await makeClient().putKeyResource("r1", {
      keyHash: "sha256:x",
      owner: "u7",
      models: ["m2"],
      maxBudget: 9,
      budgetDuration: "monthly",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw-admin:15000/api/config/resources/llm.apiKey/r1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    expect(body.value.key).toBeUndefined();
    expect(body.value.keyHash).toBe("sha256:x");
    expect(body.value.metadata).toEqual({ name: "u7", owner: "u7" });
    expect(body.value.allowedModels).toEqual(["m2"]);
    expect(body.value.budgets[0].limit).toEqual({ unit: "USD", amount: 9 });
    expect(body.value.budgets[0].window).toEqual({ rolling: "30d" });
  });

  it("tolerates 404 (resource already gone)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(
      makeClient().putKeyResource("r2", { keyHash: "sha256:y", owner: "u8" }),
    ).resolves.toBeUndefined();
  });
});

describe("usage from request logs", () => {
  const logs = {
    logs: [
      { id: "l1", completedAt: "2026-10-10T01:00:00Z", cost: 0.5, usage: { totalTokens: 100 }, genAi: { requestModel: "TestModel" } },
      { id: "l2", completedAt: "2026-10-10T02:30:00Z", cost: 1.5, usage: { totalTokens: 300 }, genAi: { requestModel: "TestModel" } },
      { id: "l3", completedAt: "2026-10-09T23:00:00Z", cost: 2, usage: { totalTokens: 50 }, genAi: { requestModel: "TestModel" } },
    ],
  };

  it("getUserInfo sums spend for the owner", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, logs));
    const info = await makeClient().getUserInfo("u7");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw-admin:15000/api/logs/search");
    expect(JSON.parse(init.body).filters.attributes["agentgateway.user"]).toBe("u7");
    expect(info?.spend).toBeCloseTo(4);
  });

  it("getSpendLogs maps entries; getSpendReport aggregates by day with a time range", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, logs));
    const entries = await makeClient().getSpendLogs({ start_date: "2026-10-09T00:00:00Z", end_date: "2026-10-11T00:00:00Z", user_id: "u7" });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ request_id: "l1", call_type: "chat", spend: 0.5, tokens: 100, model: "TestModel" });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, logs));
    const report = await makeClient().getSpendReport({ start_date: "2026-10-09T00:00:00Z", end_date: "2026-10-11T00:00:00Z", user_id: "u7" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).timeRange).toEqual({
      from: "2026-10-09T00:00:00Z",
      to: "2026-10-11T00:00:00Z",
    });
    const day = report.find((r) => r.group_by_day === "2026-10-10");
    expect(day).toMatchObject({ spend: 2, total_tokens: 400 });
  });
});

describe("listModels + health + config gate", () => {
  it("listModels reads models and virtualModels from the effective config", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { llm: { models: [{ name: "a" }, { name: "b" }], virtualModels: [{ name: "TestModel" }] } }),
    );
    const models = await makeClient().listModels();
    expect(models.map((m) => m.id)).toEqual(["a", "b", "TestModel"]);
  });

  it("health probes the effective config", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(makeClient().health()).resolves.toBe(true);
    fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(makeClient().health()).resolves.toBe(false);
  });

  it("isGatewayConfigured requires enabled + adminUrl (no master key)", () => {
    expect(isGatewayConfigured({ enabled: true, adminUrl: "http://x" })).toBe(true);
    expect(isGatewayConfigured({ enabled: false, adminUrl: "http://x" })).toBe(false);
    expect(isGatewayConfigured({ enabled: true, adminUrl: undefined })).toBe(false);
  });
});
