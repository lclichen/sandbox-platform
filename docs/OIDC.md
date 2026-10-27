# OIDC 统一身份登录（标准 OpenID Connect）

> 2026-10-26 落地。授权码流 + PKCE(S256)，零第三方依赖（发现文档/JWKS 验签均
> 内建）。适用于企业内网已有的任何标准 OIDC IdP（Keycloak、Casdoor、
> Authentik、Azure AD ENTRA、Okta 私有化等）。

## 1. 启用配置（平台环境变量）

```bash
OIDC_ENABLED=on
OIDC_ISSUER_URL=https://idp.example.com          # 发现文档取 <issuer>/.well-known/openid-configuration
OIDC_CLIENT_ID=amedac-platform
OIDC_CLIENT_SECRET=********
# 可选：
OIDC_LABEL=统一身份登录                            # 登录页按钮文案（默认 "OIDC"）
OIDC_SCOPES=openid profile email                 # 默认即此，一般不用改
OIDC_AUTHORIZATION_ENDPOINT=...                  # 无发现文档的 IdP 逐项覆盖（三 个都填才跳过发现）
OIDC_TOKEN_ENDPOINT=...
OIDC_JWKS_URI=...
OIDC_ALLOWED_REDIRECTS=http://piweb1.local/api/webauth/oidc/callback,http://piweb2.local/...
                                                 # 回跳白名单（前缀匹配）；不配则放行任意 http(s) 来源
```

IdP 侧登记回调地址：`<平台对外地址>/api/v1/auth/oidc/callback`。

## 2. 与 REGISTER_MODE 的关系

**OIDC 自动建户不受 `REGISTER_MODE` 约束**——IdP 已完成身份核验，与匿名
自助注册（`REGISTER_MODE=open/approval`）是两回事。`REGISTER_MODE` 默认
仍为 `off`：控制的是本地密码自助注册。

## 3. 行为要点

- **匹配键是 `oidc_sub`**（IdP 的 sub claim，唯一索引），不是用户名——
  持有同名 IdP 账号的人**不能**接管既有本地账户；用户名冲突时自动派生
  `alice-1` 后缀。
- OIDC 用户恒为 `user` 角色、`active` 状态、本地密码为随机不可知值
  （本地密码登录对 OIDC 账户不可用）。
- **admin 本地账号不受影响**，继续用本地密码登录。
- id_token 仅接受 **RS256/ES256** 非对称签名（JWKS 验签），校验
  iss/aud/exp/nonce（防重放）；显式拒绝 HS256（客户端密钥模式下可伪造）。
- 令牌交接：回调成功后平台生成 **60 秒一次性 handoff code** 302 回
  pi-web，pi-web 服务端 `/oidc/exchange` 换取令牌对——令牌不进浏览器
  URL/日志，code 一次性（重放 401）。

## 4. API

| 用途 | 方法 + 路径 |
|---|---|
| 能力位 | `GET /api/v1/auth/config` → `{ registerMode, oidc: { enabled, label } }` |
| 发起授权 | `GET /api/v1/auth/oidc/begin?redirect_uri=<pi-web 回调>` → 302 IdP |
| IdP 回调 | `GET /api/v1/auth/oidc/callback?code&state` → 302 pi-web（带 handoff code） |
| 令牌交接 | `POST /api/v1/auth/oidc/exchange { code }` → `{ accessToken, refreshToken, user }` |

## 5. pi-web 侧（自动生效）

登录页出现「使用〈OIDC_LABEL〉登录」按钮（`/api/webauth/oidc/begin` 起
步），回调 `/api/webauth/oidc/callback` 建立与密码登录完全相同的 pi-web
会话（含专用平台 API key）。平台未启用/未升级时按钮自动隐藏。

## 6. 测试

`npx vitest --run test/oidc.test.ts`——9 例：state 编解码/防篡改、PKCE、
授权 URL、id_token 验签（进程内 RSA + mock 发现文档/JWKS/token 端点）、
nonce/iss/aud 拒绝、`upsertOidcUser` 的 sub 复用与用户名冲突派生、以及
begin→callback→exchange 的完整授权码流（含 code 一次性重放拒绝）。
