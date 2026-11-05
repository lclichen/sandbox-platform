/**
 * OIDC 单元 + 集成测试：state 编解码、PKCE、授权 URL；verifyIdToken 用进
 * 程内生成的 RSA 密钥对 + mock fetch（发现文档/JWKS）；upsertOidcUser 的
 * sub 复用与用户名冲突派生；路由开关行为。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";

// config.ts 首次 loadConfig 即缓存，而顶部静态 import（helper → app →
// config）会先于任何语句执行——env 必须在 import 之前就位。
vi.hoisted(() => {
  process.env.OIDC_ENABLED = "on";
  process.env.OIDC_ISSUER_URL = "https://idp.test";
  process.env.OIDC_CLIENT_ID = "pi-web-client";
  process.env.OIDC_CLIENT_SECRET = "pi-web-secret";
});
import { setupTestApp, teardownTestApp, type TestContext } from "./helper.ts";

const TEST_LOCAL_PASSWORD = "LocalPass1234"; // secret-scan:allow 测试夹具（本地 alice 的临时密码）
const { encodeFlowState, decodeFlowState, createPkcePair, buildAuthorizeUrl, verifyIdToken } =
  await import("../src/auth/oidc.ts");

let ctx: TestContext | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** 全套测试共用一对密钥：oidc.ts 的 JWKS 缓存 10 分钟，换钥会假失败。 */
const IDP_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** 用共用密钥签发 id_token + mock 发现文档/JWKS。 */
function mockIdp(extra: { nonce?: string; sub?: string; iss?: string; aud?: string } = {}) {
  const { publicKey, privateKey } = IDP_KEYS;
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const nonce = extra.nonce ?? b64url(randomBytes(16));
  const header = { alg: "RS256", kid: "k1", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: extra.iss ?? "https://idp.test",
    aud: extra.aud ?? "pi-web-client",
    sub: extra.sub ?? "user-123",
    nonce,
    preferred_username: "alice",
    email: "alice@example.com",
    email_verified: true,
    iat: now,
    exp: now + 300,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const idToken = `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;

  const endpoints = {
    issuer: "https://idp.test",
    authorization_endpoint: "https://idp.test/authorize",
    token_endpoint: "https://idp.test/token",
    jwks_uri: "https://idp.test/jwks",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === "https://idp.test/.well-known/openid-configuration") {
        return new Response(JSON.stringify(endpoints), { status: 200 });
      }
      if (u === "https://idp.test/jwks") {
        return new Response(
          JSON.stringify({ keys: [{ ...jwk, kid: "k1", kty: "RSA", use: "sig" }] }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );
  // token 端点也 mock：POST /token 返回刚才签发的 id_token（code 任意接受）。
  const baseMock = globalThis.fetch as unknown as (
    url: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  const wrappedFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === "https://idp.test/token") {
      return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer", id_token: idToken }), { status: 200 });
    }
    return baseMock(url, init);
  });
  vi.stubGlobal("fetch", wrappedFetch);
  return { idToken, nonce, payload };
}

describe("oidc state/pkce/authorize-url", () => {
  it("flow state round-trips and rejects tampered/expired values", () => {
    const state = encodeFlowState({
      verifier: "v",
      nonce: "n",
      redirectUri: "http://x/cb",
      exp: Date.now() + 60_000,
    });
    const decoded = decodeFlowState(state);
    expect(decoded?.verifier).toBe("v");
    expect(decodeFlowState(state.slice(0, -3) + "aaa")).toBeNull();
    expect(
      decodeFlowState(encodeFlowState({ verifier: "v", nonce: "n", redirectUri: "http://x", exp: Date.now() - 1 })),
    ).toBeNull();
    expect(decodeFlowState(undefined)).toBeNull();
  });

  it("PKCE pair is S256-consistent; authorize URL carries PKCE + nonce + state", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(
      buildAuthorizeUrl(
        {
          issuer: "",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "",
          jwks_uri: "",
        } as never,
        {
          clientId: "cid",
          scopes: "openid profile",
          redirectUri: "http://app/cb",
          state: "s1",
          nonce: "n1",
          challenge,
        },
      ),
    );
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("n1");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("oidc verifyIdToken", () => {
  it("accepts a properly signed RS256 token", async () => {
    const { idToken, nonce } = mockIdp();
    const claims = await verifyIdToken(idToken, nonce);
    expect(claims.sub).toBe("user-123");
    expect(claims.preferred_username).toBe("alice");
  });

  it("rejects nonce mismatch (replay), wrong issuer, wrong audience", async () => {
    const { idToken, nonce } = mockIdp();
    await expect(verifyIdToken(idToken, "wrong-nonce")).rejects.toThrow(/nonce/);

    const badIss = mockIdp({ nonce, iss: "https://evil.test" });
    await expect(verifyIdToken(badIss.idToken, nonce)).rejects.toThrow(/issuer/);

    const badAud = mockIdp({ nonce, aud: "other-client" });
    await expect(verifyIdToken(badAud.idToken, nonce)).rejects.toThrow(/audience/);
  });
});

describe("oidc routes & provisioning", () => {
  it("/auth/config advertises the oidc capability", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().get("/api/v1/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.oidc).toMatchObject({ enabled: true });
  });

  it("/oidc/begin validates redirect_uri, then redirects to the IdP with PKCE + state cookie", async () => {
    ctx = await setupTestApp();
    const bad = await ctx.request().get("/api/v1/auth/oidc/begin");
    expect(bad.status).toBe(400);
    const bad2 = await ctx.request().get("/api/v1/auth/oidc/begin?redirect_uri=ftp://x");
    expect(bad2.status).toBe(400);

    mockIdp();
    const res = await ctx
      .request()
      .get("/api/v1/auth/oidc/begin?redirect_uri=http://piweb.local/api/webauth/oidc/callback");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe("https://idp.test/authorize");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const setCookie = res.headers["set-cookie"] as unknown as string | string[];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain("oidc_flow=");
    expect(cookieHeader).toContain("HttpOnly");
  });

  it("/oidc/exchange rejects unknown one-time codes", async () => {
    ctx = await setupTestApp();
    const res = await ctx.request().post("/api/v1/auth/oidc/exchange").send({ code: "nope" });
    expect(res.status).toBe(401);
  });

  it("upsertOidcUser: sub 复用、用户名冲突派生后缀（不接管本地账户）、恒为 user", async () => {
    ctx = await setupTestApp();
    const { upsertOidcUser } = await import("../src/services/oidc.service.ts");

    // 建一个同名本地用户 alice
    const reg = await ctx.request()
      .post("/api/v1/auth/register")
      .send({ username: "alice", password: TEST_LOCAL_PASSWORD });
    expect(reg.status).toBe(201);

    const first = await upsertOidcUser(ctx.db, {
      sub: "oidc-sub-1",
      preferred_username: "alice",
      email: "alice@example.com",
      email_verified: true,
    });
    expect(first.username).toBe("alice-1"); // 不接管本地 alice
    expect(first.role).toBe("user");
    expect(first.status).toBe("active");

    const again = await upsertOidcUser(ctx.db, {
      sub: "oidc-sub-1",
      preferred_username: "alice",
      email: "alice@example.com",
    });
    expect(again.id).toBe(first.id); // 同 sub 复用同一账户

    // 本地 alice 仍用本地密码登录（未被 OIDC 劫持）
    const login = await ctx.request()
      .post("/api/v1/auth/login")
      .send({ username: "alice", password: TEST_LOCAL_PASSWORD });
    expect(login.status).toBe(200);
  });

describe("oidc full authorization-code flow", () => {
  it("begin → callback → exchange issues platform tokens for an OIDC user", async () => {
    ctx = await setupTestApp();
    // 1) begin：拿 302 与 state cookie
    const begin = await ctx.request()
      .get("/api/v1/auth/oidc/begin?redirect_uri=http://piweb.local/api/webauth/oidc/callback");
    expect(begin.status).toBe(302);
    const authorizeUrl = new URL(begin.headers.location);
    const cookieHeader0 = (Array.isArray(begin.headers["set-cookie"]) ? begin.headers["set-cookie"][0] : begin.headers["set-cookie"]) as string;
    const flowCookie = cookieHeader0.split(";")[0]; // oidc_flow=<state>

    // 2) mock IdP：用 state/nonce 签一个合法 id_token，然后模拟 IdP 回跳
    const state = authorizeUrl.searchParams.get("state") ?? "";
    const nonce = authorizeUrl.searchParams.get("nonce") ?? "";
    const { verifyIdToken: verify } = await import("../src/auth/oidc.ts");
    void verify;
    const claims = mockIdp({ nonce });
    void claims;
    // mockIdp 重装了 fetch（带 token 端点），用它的 idToken 手动构造回调：
    // 注意 mockIdp 内部签发的 nonce 必须等于 authorize 请求里的 nonce。
    const cb = await ctx.request()
      .get(`/api/v1/auth/oidc/callback?code=auth-code-1&state=${encodeURIComponent(state)}`)
      .set("Cookie", flowCookie);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location);
    expect(back.origin + back.pathname).toBe("http://piweb.local/api/webauth/oidc/callback");
    const handoff = back.searchParams.get("code") ?? "";
    expect(handoff.length).toBeGreaterThanOrEqual(16);

    // 3) exchange：一次性 code 换令牌对 + 用户
    const ex = await ctx.request().post("/api/v1/auth/oidc/exchange").send({ code: handoff });
    expect(ex.status).toBe(200);
    expect(ex.body.accessToken).toBeTypeOf("string");
    expect(ex.body.user.username).toBe("alice"); // 全新 db：preferred_username 直接可用
    expect(ex.body.user.password_hash).toBeUndefined();

    // 4) code 一次性：重放 401
    const replay = await ctx.request().post("/api/v1/auth/oidc/exchange").send({ code: handoff });
    expect(replay.status).toBe(401);
  });
});
});
