/**
 * LiteLLM client: HTTP wiring + error mapping, with global fetch mocked.
 *
 * We don't hit a real LiteLLM; instead we stub globalThis.fetch to return
 * canned responses and assert the client translates them correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLitellmClient, isLitellmConfigured, RateLimitError } from "../src/services/litellm.client.ts";
import { QuotaExceededError, UnauthorizedError, BadRequestError, HttpError } from "../src/utils/errors.ts";

interface MockOpts {
  status?: number;
  body?: unknown;
  raw?: string;
  ok?: boolean;
}

function mockFetchOnce(opts: MockOpts): ReturnType<typeof vi.fn> {
  const status = opts.status ?? 200;
  const bodyText = opts.raw ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  const fn = vi.fn() as unknown as ReturnType<typeof vi.fn>;
  globalThis.fetch = fn.mockResolvedValue({
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    text: async () => bodyText,
  }) as unknown as typeof globalThis.fetch;
  return fn;
}

const origFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = origFetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

function client() {
  return createLitellmClient({ baseUrl: "http://localhost:4000", masterKey: "sk-master", timeoutMs: 2000 });
}

describe("litellm client", () => {
  it("POSTs to /key/generate with master key bearer and returns plaintext key", async () => {
    const fn = mockFetchOnce({ body: { key: "sk-virt-abc", key_name: "k1", user_id: "u1" } });
    const c = client();
    const out = await c.generateKey({ user_id: "u1" });
    expect(out.key).toBe("sk-virt-abc");
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe("http://localhost:4000/key/generate");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-master");
    expect(JSON.parse(init.body)).toEqual({ user_id: "u1" });
  });

  it("throws when /key/generate omits the key field", async () => {
    mockFetchOnce({ body: { something: "else" } });
    await expect(client().generateKey({ user_id: "u1" })).rejects.toThrow(/did not return a key/);
  });

  it("maps budget_exceeded body to QuotaExceededError(422)", async () => {
    mockFetchOnce({
      status: 400,
      body: { error: { type: "budget_exceeded", message: "Current spend 0.001, Max 0.0001", code: "400" } },
    });
    await expect(client().generateKey({ user_id: "u1" })).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("maps the 'detail' string budget shape too", async () => {
    mockFetchOnce({ status: 400, body: { detail: "ExceededTokenBudget: Current spend 1" } });
    await expect(client().generateKey({ user_id: "u1" })).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("maps 429 to RateLimitError", async () => {
    mockFetchOnce({ status: 429, body: { error: "TPM limit reached" } });
    await expect(client().generateKey({ user_id: "u1" })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("maps 401/403 to UnauthorizedError", async () => {
    mockFetchOnce({ status: 401, body: { detail: "invalid key" } });
    await expect(client().generateKey({ user_id: "u1" })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps 404 to NotFoundError", async () => {
    mockFetchOnce({ status: 404, body: { detail: "no such key" } });
    await expect(client().getKeyInfo("sk-x")).rejects.toThrow(/not found/i);
  });

  it("maps other 4xx to BadRequestError", async () => {
    mockFetchOnce({ status: 422, body: { detail: "bad payload" } });
    await expect(client().updateKey({ key: "sk-x", max_budget: 5 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("maps 5xx to HttpError(502)", async () => {
    mockFetchOnce({ status: 500, body: { detail: "boom" } });
    await expect(client().generateKey({ user_id: "u1" })).rejects.toBeInstanceOf(HttpError);
  });

  it("translates network failure to LLM_UNREACHABLE(503)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof globalThis.fetch;
    await expect(client().generateKey({ user_id: "u1" })).rejects.toMatchObject({ status: 503, code: "LLM_UNREACHABLE" });
  });

  it("/key/delete uses POST (not DELETE)", async () => {
    const fn = mockFetchOnce({ body: { deleted_keys: ["sk-x"] } });
    await client().deleteKey(["sk-x"]);
    const [, init] = fn.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ keys: ["sk-x"] });
  });

  it("/user/info normalizes wrapped and array shapes", async () => {
    mockFetchOnce({ body: { user_info: [{ user_id: "u1", spend: 1.5 }] } });
    let info = await client().getUserInfo("u1");
    expect(info?.spend).toBe(1.5);

    mockFetchOnce({ body: [{ user_id: "u1", spend: 2.5 }] });
    info = await client().getUserInfo("u1");
    expect(info?.spend).toBe(2.5);
  });

  it("/v1/models extracts the data array", async () => {
    mockFetchOnce({ body: { data: [{ id: "gpt-4o" }, { id: "claude-sonnet" }] } });
    const models = await client().listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "claude-sonnet"]);
  });

  it("/spend/logs normalizes {data: [...]} and bare array", async () => {
    mockFetchOnce({ body: { data: [{ request_id: "r1" }] } });
    let logs = await client().getSpendLogs({ start_date: "2026-01-01", end_date: "2026-01-02" });
    expect(logs).toHaveLength(1);

    mockFetchOnce({ body: [{ request_id: "r2" }] });
    logs = await client().getSpendLogs({ start_date: "2026-01-01", end_date: "2026-01-02" });
    expect(logs[0].request_id).toBe("r2");
  });

  it("builds GET query strings and skips empty values", async () => {
    const fn = mockFetchOnce({ body: { keys: [] } });
    await client().listKeys({ user_id: "u1" });
    const [url] = fn.mock.calls[0];
    expect(String(url)).toContain("/key/list?user_id=u1");
  });

  it("health() returns false on failure instead of throwing", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof globalThis.fetch;
    await expect(client().health()).resolves.toBe(false);
  });

  it("isLitellmConfigured requires enabled + masterKey", () => {
    expect(isLitellmConfigured({ enabled: true, litellm: { masterKey: "sk-x" } })).toBe(true);
    expect(isLitellmConfigured({ enabled: true, litellm: { masterKey: undefined } })).toBe(false);
    expect(isLitellmConfigured({ enabled: false, litellm: { masterKey: "sk-x" } })).toBe(false);
  });
});
