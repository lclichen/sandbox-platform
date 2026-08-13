/**
 * API client tests (P1-9).
 *
 * Covers the two highest-value, regression-prone pieces of the client:
 *   - qs(): query serialization that must drop undefined/"" (the classic
 *     URLSearchParams "search=undefined" footgun documented in AGENTS.md)
 *   - request(): 401 → transparent refresh + retry once, then error mapping
 *
 * fetch is mocked globally; no network and no DOM is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, qs, ApiError, request, setAccessToken, setRefreshToken, setOnAuthFailure, setOnTokensRefreshed } from "../src/api/client";

const origFetch = globalThis.fetch;

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  setAccessToken(undefined);
  setRefreshToken(undefined);
  setOnAuthFailure(() => {});
  setOnTokensRefreshed(() => {});
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe("qs", () => {
  it("drops undefined values (the documented footgun)", () => {
    expect(qs({ a: "1", b: undefined, c: "2" })).toBe("a=1&c=2");
  });

  it("drops empty-string values", () => {
    expect(qs({ a: "1", b: "", c: "2" })).toBe("a=1&c=2");
  });

  it("keeps zero and falsy-but-defined numbers as '0'", () => {
    expect(qs({ page: 0, limit: 10 })).toBe("page=0&limit=10");
  });

  it("returns empty string when all params are dropped", () => {
    expect(qs({ a: undefined, b: "" })).toBe("");
  });

  it("serializes a single param without a trailing &", () => {
    expect(qs({ only: "x" })).toBe("only=x");
  });
});

describe("request", () => {
  it("sends the bearer token when set", async () => {
    let sentAuth: string | undefined;
    mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      sentAuth = (init?.headers as Record<string, string>)?.Authorization;
      return jsonRes({ ok: true });
    } as unknown as typeof fetch);
    setAccessToken("tok-123");
    await request("/api/v1/x");
    expect(sentAuth).toBe("Bearer tok-123");
  });

  it("returns parsed JSON on 2xx", async () => {
    mockFetch(async () => jsonRes({ hello: "world" }) as unknown as Response);
    const out = await request<{ hello: string }>("/x");
    expect(out.hello).toBe("world");
  });

  it("maps non-2xx to ApiError with code+message", async () => {
    mockFetch(async () => jsonRes({ code: "not_found", message: "nope" }, 404) as unknown as Response);
    await expect(request("/x")).rejects.toMatchObject({ status: 404, code: "not_found", message: "nope" });
    expect(await request("/x").catch((e) => e)).toBeInstanceOf(ApiError);
  });

  it("refreshes once on 401 and retries the original request", async () => {
    setAccessToken("expired");
    setRefreshToken("refresh-ok");
    let calls = 0;
    let refreshCalled = false;
    mockFetch(async (url: string | URL | Request) => {
      const path = String(url);
      calls += 1;
      if (path.endsWith("/auth/refresh")) {
        refreshCalled = true;
        return jsonRes({ accessToken: "new-acc", refreshToken: "new-ref" });
      }
      // First call to the real endpoint 401s; the retry (after refresh) succeeds.
      if (calls === 1) return jsonRes({ code: "unauthorized" }, 401);
      return jsonRes({ ok: true });
    } as unknown as typeof fetch);

    let refreshedPair: { a: string; r: string } | undefined;
    setOnTokensRefreshed((a, r) => (refreshedPair = { a, r }));

    const out = await request<{ ok: boolean }>("/api/v1/x");
    expect(out.ok).toBe(true);
    expect(refreshCalled).toBe(true);
    expect(refreshedPair).toEqual({ a: "new-acc", r: "new-ref" });
  });

  it("triggers onAuthFailure when refresh has no token to use", async () => {
    setAccessToken("expired");
    // no refresh token set
    let authFailed = false;
    setOnAuthFailure(() => (authFailed = true));
    mockFetch(async () => jsonRes({ code: "unauthorized" }, 401) as unknown as Response);
    await expect(request("/x")).rejects.toBeInstanceOf(ApiError);
    expect(authFailed).toBe(true);
  });

  it("treats 204 as undefined (no body parse)", async () => {
    mockFetch(async () => ({ ok: true, status: 204 } as unknown as Response));
    const out = await request("/x");
    expect(out).toBeUndefined();
  });

  it("does not attempt refresh when using an API key (no token cycle)", async () => {
    // The client only refreshes on 401 when a refresh token is present; with a
    // bare expired access token and no refresh token, it must NOT loop.
    setAccessToken("expired");
    let endpointHits = 0;
    mockFetch(async () => {
      endpointHits += 1;
      return jsonRes({ code: "unauthorized" }, 401);
    } as unknown as Response);
    await expect(request("/x")).rejects.toBeInstanceOf(ApiError);
    // Exactly one hit to the endpoint (no refresh attempt, no retry).
    expect(endpointHits).toBe(1);
  });
});

describe("api endpoint wrappers use qs", () => {
  it("listUsers drops undefined filters from the URL", async () => {
    let capturedUrl = "";
    mockFetch(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return jsonRes({ total: 0, users: [] });
    } as unknown as typeof fetch);
    setAccessToken("t");
    await api.listUsers({ search: undefined, limit: 5 });
    // No `search=` fragment leaks into the URL.
    expect(capturedUrl).toContain("limit=5");
    expect(capturedUrl).not.toContain("search=");
    expect(capturedUrl).not.toContain("undefined");
  });
});
