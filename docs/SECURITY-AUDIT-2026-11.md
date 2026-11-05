# 安全审计与加固记录（2026-11-05）

范围：`sandbox-platform` 后端（Express API、执行器、工作区存储、认证与配置）。
方法：`npm audit` + 手工代码审计（认证/授权/注入/路径穿越/资源上限/密钥管理）。

## 1. 依赖漏洞

审计前：**22 个漏洞（4 critical / 13 high / 5 moderate）**，直接依赖
`express@4.21.2`、`bcrypt@5.1.1`（经 `@mapbox/node-pre-gyp` → `tar` 放大为
critical）、`nanoid@5.0.9`、`zod@3.24.1`；dev 链有 `tinypool` critical。

升级后：**`npm audit` = 0 vulnerabilities**。

| 包 | 升级 | 原因 |
|---|---|---|
| express | 4.21.2 → 5.3.0 | 4.22.3 仍钉死有漏洞的 `body-parser ~1.20.5` / `proxy-addr ~2.0.7`；5.3.0 使用修复版 |
| bcrypt | 5.1.1 → 6.0.0 | 移除 `node-pre-gyp`/`tar` 链；有 win32-x64 prebuild |
| zod | 3.24.1 → 4.6.7 | 3.x 无修复版本（内存耗尽 advisory） |
| nanoid | 5.0.9 → 5.1.16 | 多个 DoS/整数溢出 advisory |
| express-rate-limit | 7 → 8 | 与 Express 5 配套 |
| vitest | 2.1.8 → 4.1.12 | `@vitest/mocker` / `tinypool` critical |
| pg / node-ssh / jsonwebtoken / dotenv / pino | 补丁/小版本 | 常规维护 |
| safe-regex2 | 新增 | grep 用户正则的 ReDoS 预检 |

注意：`npm install` 需要 `--legacy-peer-deps`（npm 10.9 + vitest 4 peer 解析
的 arborist 崩溃），`npm ci` 可直接用当前 lockfile。

## 2. 已修复的高危问题

1. **OIDC 回跳白名单前缀绕过** `src/routes/auth.routes.ts`
   - `startsWith` 会接受 `https://pi.example.com.evil.com`。
   - 改为 URL origin + 路径边界匹配；拒绝 userinfo、非 http(s)。
   - 生产环境强制 `OIDC_ALLOWED_REDIRECTS` 非空（`config.ts`）。

2. **私有镜像越权** `src/services/quota.service.ts` / `container.service.ts`
   - 原逻辑对 `is_public=false` 直接 `return`，注释称“调用方会检查”，但没有任何调用方检查。
   - 现在普通用户创建私有镜像容器返回 403 `IMAGE_NOT_ALLOWED`；admin 允许。

3. **PTY 泄露平台进程环境** `src/executors/apptainer-cli-executor.ts`
   - `openPty` 原为 `env: { ...process.env }`，容器终端可 `env` 读到
     `JWT_SECRET`、DB/SSH 密码、LLM key。
   - 改用 `src/executors/safe-env.ts` 白名单（mock 执行器也复用同一策略）。

4. **工作区符号链接逃逸** `src/services/workspace-storage.ts`
   - 原 `secureResolve` 只 realpath 最终路径；父目录是符号链接、最终文件不存在时，
     `writeFile/makeDir/move` 会在工作区外创建文件。
   - 新增 `assertNoSymlinkComponents`：拒绝根目录以下任意符号链接组件（含悬空链接）。
   - 列表/树/统计改用 `lstat`，不再跟随符号链接泄露目标大小。
   - `container-mounts.resolveInputSource` 复用 `secureResolve`；输入项内任意符号链接直接拒绝；
     `ensureOutputDir` 也走安全解析，防止 `outputs -> 外部目录` 的 bind 逃逸。

5. **分块上传无上限写盘** `src/services/workspace-storage.ts`
   - 每个 part 限 8 MiB；每次写入累计 `receivedBytes` 并检查总上限；
     兼容旧 session（无计数字段时扫描已有 part）。
   - `collectUploadParts` 先 stat 再读取，避免为超限 session 分配大内存。
   - `rawPart` 超限返回 413 并丢弃连接（不再继续拼 body）。

6. **JWT 角色/状态不新鲜** `src/auth/middleware.ts`
   - 原实现信任 JWT 里的 `role`；管理员被降权后旧 token 在 15 分钟内仍是 admin。
   - `requireAuth` 现在用数据库行的 `role/username` 覆盖 claims；
     `authenticateCredential` 同样校验 `status` + `token_version`。
   - `PATCH /admin/users/:id` 改角色/状态时递增 `token_version` 并吊销全部 refresh token。

7. **登录账号枚举** `src/services/auth.service.ts`
   - 原实现验密前返回 `ACCOUNT_PENDING`/`ACCOUNT_DISABLED`，任意密码即可探测账号。
   - 现在先 bcrypt 验密，失败统一 401；密码正确才暴露 pending/disabled。

8. **未认证大 body DoS** `src/app.ts`
   - 原 `express.json({ limit: "16mb" })` 在限流器之前执行，登录接口可被 16 MB body 打。
   - 限流中间件已前移到 body parser 之前；`/auth/oidc` 新增 30/min 限流。

9. **bash 输出无界缓冲** 三个 executor + `tools.service`
   - 新增 `ExecOptions.maxOutputBytes`（8 MiB，stdout+stderr 共享）；超限 kill 并返回
     `outputTruncated`；mock/CLI/SSH 均实现（SSH 通过 `onStdout/onStderr/onChannel` 提前关通道）。
   - `execBuffer`（导出 /workspace tar）也受上传上限约束。

10. **刷新令牌并发重放** `src/services/auth.service.ts`
    - 轮换改为条件更新 `WHERE id = ? AND revoked_at IS NULL`，只有一个并发请求能成功；
      失败方按重放处理并吊销整个 family。

11. **聚合磁盘配额漏算孤儿快照** `src/services/quota.service.ts`
    - 原 SQL 只统计仍关联未销毁容器的快照；容器销毁后快照仍占盘却不计数。
    - 现在按 `snapshots.user_id` 计入全部快照。

12. **其他**
    - `container.service.toPublic` secret env 掩码从后缀改为子串（`OPENAI_APIKEY`/`DB_PASS` 等）。
    - admin 对他人容器做快照时，快照归属与配额记到容器 owner，而不是 admin。
    - `resolveImagePath` 拒绝相对路径 `../` 逃逸 `IMAGE_BASE_DIR`。
    - agentgateway admin API 支持 `AGENTGATEWAY_ADMIN_TOKEN` Bearer 认证。
    - OIDC `id_token` 增加多 audience `azp`、`nbf`、`iat` 校验；OIDC 端点默认要求 HTTPS
      （`OIDC_ALLOW_INSECURE_HTTP=true` 可显式放宽）。
    - `.env.example` 的 `RATE_LIMIT_ENABLED` 从 `false` 改为 `true`（复制即关闭限流是真实陷阱）。
    - SQLite 文件创建后 `chmod 0600`（POSIX 平台）。
    - PTY 升级时重新读取用户状态/角色，60 秒 ticket 不再保留降权前的 admin 权限。
    - API key 每用户最多 50 个活跃 key。

## 3. 回归测试

- 新增 `test/security.hardening.test.ts`（10 项）：OIDC 回跳绕过、私有镜像、
  角色降权、登录枚举、并发 refresh、符号链接写逃逸、分块上传总上限、env 掩码。
- 新增 `test/limits.config.test.ts`（2 项）：限流/上限的默认值与环境变量覆盖
  （与 `docs/LIMITS.md` 对齐）。
- `npx tsc --noEmit`：0 错误。
- `npx vitest run`：**265 passed / 8 failed**。8 个失败与改造前基线完全一致：
  5 个 `extension-client.smoke`（依赖 127.0.0.1:3000 外部服务）、
  2 个 `api-key.smoke`（同上）、1 个已下线的 `web/dist` SPA 静态页测试。
  本次未新增失败。

## 4. 残余风险 / 部署建议

1. **工作区大文件已改为流式**：直传使用请求流 → 暂存文件 → 原子 rename，分块合并逐 part
   写入，下载使用 `res.sendFile` 流式响应；默认单文件上限 2 GiB
   （`WORKSPACE_UPLOAD_MAX_BYTES`）。`export-workspace` 仍会缓冲 tar.gz，
   由 `WORKSPACE_EXPORT_MAX_BYTES`（默认 512 MiB）单独限制。
2. **`workspace` 目录的并发 TOCTOU**：已拒绝符号链接组件，但容器进程可并发创建链接；
   Linux 上可进一步用 `openat2(RESOLVE_BENEATH)` 或专用低权限账号消除竞态。
3. **grep 的 ReDoS 是启发式防护**（`safe-regex2` + 行长/时间预算），不是形式化保证；
   对不可信正则可考虑 RE2/WASM 引擎。
4. **Mock 执行器仍是 host shell**（dev-only；生产启动会拒绝）。不要在生产设置
   `ALLOW_MOCK_EXECUTOR_IN_PRODUCTION=1`。
5. **本机 `.env` 当前值**（未提交）：`RATE_LIMIT_ENABLED=false`、`REGISTER_MODE=open`、
   `EXECUTOR_KIND=mock`。生产部署必须改为 `true` / `approval|off` / `ssh|apptainer-cli`。
6. **明文 HTTP 部署**：平台本身不监听 TLS，CSP 关闭了 HSTS/upgrade-insecure-requests；
   生产应放在 TLS 反代后，并设置 `TRUST_PROXY`。
7. **审计日志 hash 链**在 PostgreSQL 并发写入下仍可能竞争同一 `prev_hash`（已有文档注明）；
   单进程 sqlite 部署无此问题。
