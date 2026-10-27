/**
 * OIDC relying-party core（零第三方依赖，Node ≥20）。
 *
 * 授权码流 + PKCE(S256)：
 *   GET /oidc/begin      → 302 IdP 授权端点（state/nonce/PKCE 存 HttpOnly Cookie）
 *   GET /oidc/callback   → 换 token → 验 id_token（JWKS, RS256/ES256）→ 建户/登录
 *                          → 302 回 pi-web，携 60s 一次性 handoff code
 *   POST /oidc/exchange  → handoff code 换平台 token pair（pi-web 服务端调用）
 *
 * id_token 验证只信任非对称签名（RS256/ES256）——客户端密钥模式下
 * HS256 会用 client_secret 签名，任何拿到 secret 的组件都能伪造用户，
 * 明确拒绝。发现文档与 JWKS 进程内缓存 10 分钟。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual, createVerify } from "node:crypto";
import { loadConfig } from "../config.ts";

export interface OidcEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Cached<T> {
  value: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
/** 最小 JWK 形状（DOM lib 的 JsonWebKey 在本工程 lib 配置下不可用）。 */
export interface JwkKey {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  [ext: string]: unknown;
}

const discoveryCache = new Map<string, Cached<OidcEndpoints>>();
const jwksCache = new Map<string, Cached<JwkKey[]>>();

export function oidcEnabled(): boolean {
  const cfg = loadConfig().oidc;
  return cfg.enabled && Boolean(cfg.issuerUrl && cfg.clientId);
}

export async function discoverEndpoints(): Promise<OidcEndpoints> {
  const cfg = loadConfig().oidc;
  const explicit: OidcEndpoints = {
    issuer: cfg.issuerUrl,
    authorization_endpoint: cfg.authorizationEndpoint ?? "",
    token_endpoint: cfg.tokenEndpoint ?? "",
    jwks_uri: cfg.jwksUri ?? "",
  };
  if (explicit.authorization_endpoint && explicit.token_endpoint && explicit.jwks_uri) {
    return explicit; // 显式覆盖：不做发现
  }
  const cached = discoveryCache.get(cfg.issuerUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const res = await fetch(`${cfg.issuerUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OIDC 发现文档请求失败（HTTP ${res.status}）`);
  const doc = (await res.json()) as Partial<OidcEndpoints>;
  const merged: OidcEndpoints = {
    issuer: doc.issuer ?? cfg.issuerUrl,
    authorization_endpoint: explicit.authorization_endpoint || doc.authorization_endpoint || "",
    token_endpoint: explicit.token_endpoint || doc.token_endpoint || "",
    jwks_uri: explicit.jwks_uri || doc.jwks_uri || "",
  };
  if (!merged.authorization_endpoint || !merged.token_endpoint || !merged.jwks_uri) {
    throw new Error("OIDC 发现文档缺少 authorization_endpoint/token_endpoint/jwks_uri");
  }
  discoveryCache.set(cfg.issuerUrl, { value: merged, fetchedAt: Date.now() });
  return merged;
}

async function fetchJwks(jwksUri: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
  const res = await fetch(jwksUri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS 请求失败（HTTP ${res.status}）`);
  const doc = (await res.json()) as { keys?: JwkKey[] };
  const keys = Array.isArray(doc.keys) ? doc.keys : [];
  if (keys.length === 0) throw new Error("JWKS 为空");
  jwksCache.set(jwksUri, { value: keys, fetchedAt: Date.now() });
  return keys;
}

// ---------------------------------------------------------------------------
// state/nonce/PKCE（state 用 jwtSecret 做 HMAC 签名，10 分钟有效）。

export interface OidcFlowState {
  verifier: string;
  nonce: string;
  redirectUri: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function stateSignature(payload: string): string {
  return createHmac("sha256", loadConfig().auth.jwtSecret).update(payload).digest("base64url");
}

export function encodeFlowState(state: OidcFlowState): string {
  const payload = b64url(Buffer.from(JSON.stringify(state), "utf8"));
  return `${payload}.${stateSignature(payload)}`;
}

export function decodeFlowState(raw: string | undefined): OidcFlowState | null {
  if (!raw || !raw.includes(".")) return null;
  const [payload, sig] = raw.split(".");
  const expected = stateSignature(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcFlowState;
    if (typeof state.exp !== "number" || state.exp < Date.now()) return null;
    return state;
  } catch {
    return null;
  }
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createNonce(): string {
  return b64url(randomBytes(24));
}

// ---------------------------------------------------------------------------
// 授权 URL / code 换 token / id_token 验证。

export function buildAuthorizeUrl(endpoints: OidcEndpoints, params: {
  clientId: string;
  scopes: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForTokens(endpoints: OidcEndpoints, params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.verifier,
  });
  const res = await fetch(endpoints.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const doc = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || doc.error || !doc.id_token) {
    throw new Error(`OIDC token 交换失败：${doc.error ?? `HTTP ${res.status}`}${doc.error_description ? `（${doc.error_description}）` : ""}`);
  }
  return { idToken: doc.id_token };
}

export interface OidcClaims {
  sub: string;
  preferred_username?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** 仅非对称签名（RS256/ES256）；校验 iss/aud/exp/nonce。 */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<OidcClaims> {
  const cfg = loadConfig().oidc;
  const endpoints = await discoverEndpoints();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 格式无效");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  const signature = Buffer.from(parts[2], "base64url");

  const alg = String(header.alg ?? "");
  if (alg !== "RS256" && alg !== "ES256") {
    throw new Error(`id_token 签名算法不受信任（${alg}）：仅接受 RS256/ES256`);
  }
  const kid = typeof header.kid === "string" ? header.kid : "";
  const keys = await fetchJwks(endpoints.jwks_uri);
  const jwk = (kid ? keys.filter((k) => k.kid === kid) : keys)
    .find((k) => (k.kty === "RSA" && alg === "RS256") || (k.kty === "EC" && alg === "ES256"));
  if (!jwk) throw new Error("JWKS 中没有匹配的验签密钥");

  const { createPublicKey } = await import("node:crypto");
  const pem = createPublicKey({ key: jwk as never, format: "jwk" });
  const verifier = createVerify(alg === "RS256" ? "RSA-SHA256" : "sha256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  const verifyOptions = alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : undefined;
  // @ts-expect-error — Node 类型对 options 参数支持不完整
  if (!verifier.verify(pem, signature, verifyOptions)) {
    throw new Error("id_token 签名验证失败");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== endpoints.issuer) throw new Error(`id_token issuer 不符（${String(payload.iss)}）`);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.clientId)) throw new Error("id_token audience 不符");
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new Error("id_token 已过期");
  if (payload.nonce !== expectedNonce) throw new Error("id_token nonce 不符（可能重放）");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("id_token 缺少 sub");

  return {
    sub: payload.sub,
    preferred_username: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
    email_verified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}
