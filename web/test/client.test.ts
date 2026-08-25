/**
 * API client tests (P1-9).
 *
 * Covers the two highest-value, regression-prone pieces of the client:
 *   - qs(): query serialization that must drop undefined/"" (the classic
 *     URLSearchParams "search=undefined" footgun documented in AGENTS.md)
 *   - request(): 401 → transparent refresh + retry once, then error mapping
 *
 * fetch is mocked globally; no network and no DOM is needed. Response objects
 * are built via the jsonRes/noBodyRes helpers below (esbuild, which vite uses
 * to transform tests, cannot parse type assertions after arrow-function bodies,
 * so we never write `=> x as Response` — the helpers return Response directly).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, qs, ApiError, request, setAccessToken, setRefreshToken, setOnAuthFailure, setOnTokensRefreshed } from "../src/api/client";

const origFetch = globalThis.fetch;

/** Mock global fetch with a plain handler (url, init) => Response. */
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof url === "string" ? url : String(url), init)) as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function noBodyRes(status: number): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => "" } as Response;
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
    mockFetch((_url, init) => {
      sentAuth = (init?.headers as Record<string, string>)?.Authorization;
      return jsonRes({ ok: true });
    });
    setAccessToken("tok-123");
    await request("/api/v1/x");
    expect(sentAuth).toBe("Bearer tok-123");
  });

  it("returns parsed JSON on 2xx", async () => {
    mockFetch(() => jsonRes({ hello: "world" }));
    const out = await request<{ hello: string }>("/x");
    expect(out.hello).toBe("world");
  });

  it("maps non-2xx to ApiError with code+message", async () => {
    mockFetch(() => jsonRes({ code: "not_found", message: "nope" }, 404));
    await expect(request("/x")).rejects.toMatchObject({ status: 404, code: "not_found", message: "nope" });
    expect(await request("/x").catch((e) => e)).toBeInstanceOf(ApiError);
  });

  it("refreshes once on 401 and retries the original request", async () => {
    setAccessToken("expired");
    setRefreshToken("refresh-ok");
    let calls = 0;
    let refreshCalled = false;
    mockFetch((url) => {
      calls += 1;
      if (url.endsWith("/auth/refresh")) {
        refreshCalled = true;
        return jsonRes({ accessToken: "new-acc", refreshToken: "new-ref" });
      }
      // First call to the real endpoint 401s; the retry (after refresh) succeeds.
      if (calls === 1) return jsonRes({ code: "unauthorized" }, 401);
      return jsonRes({ ok: true });
    });

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
    mockFetch(() => jsonRes({ code: "unauthorized" }, 401));
    await expect(request("/x")).rejects.toBeInstanceOf(ApiError);
    expect(authFailed).toBe(true);
  });

  it("treats 204 as undefined (no body parse)", async () => {
    mockFetch(() => noBodyRes(204));
    const out = await request("/x");
    expect(out).toBeUndefined();
  });

  it("does not attempt refresh when using an API key (no token cycle)", async () => {
    // The client only refreshes on 401 when a refresh token is present; with a
    // bare expired access token and no refresh token, it must NOT loop.
    setAccessToken("expired");
    let endpointHits = 0;
    mockFetch(() => {
      endpointHits += 1;
      return jsonRes({ code: "unauthorized" }, 401);
    });
    await expect(request("/x")).rejects.toBeInstanceOf(ApiError);
    // Exactly one hit to the endpoint (no refresh attempt, no retry).
    expect(endpointHits).toBe(1);
  });
});

describe("api endpoint wrappers use qs", () => {
  it("listUsers drops undefined filters from the URL", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonRes({ total: 0, users: [] });
    });
    setAccessToken("t");
    await api.listUsers({ search: undefined, limit: 5 });
    // No `search=` fragment leaks into the URL.
    expect(capturedUrl).toContain("limit=5");
    expect(capturedUrl).not.toContain("search=");
    expect(capturedUrl).not.toContain("undefined");
  });
});
