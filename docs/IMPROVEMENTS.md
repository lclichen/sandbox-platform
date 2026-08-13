# 改进追踪清单

本文件追踪 AgentSandbox 项目已识别的改进项及其状态。每项标注优先级（P0 高 / P1 中 / P2 低）、位置、问题、方案、状态。

- 状态图例：☐ 待办 · ► 进行中 · ✓ 完成 · ✗ 跳过（附理由）
- 完成项保留记录，便于回溯；新增改进项追加到对应优先级末尾。

---

## P0 — 高优先（安全 / 正确性）

### P0-1 · LLM key reveal 端点限流 ✓
- **位置**：`sandbox-platform/src/app.ts`（limiter 挂载）、`src/middleware/rate-limit.ts`
- **问题**：`POST /api/v1/llm/me/keys/:id/reveal` 每次解密 + 明文回传，却无任何限流。被盗 token 可无限次 hammer 暴露明文 key。当前只有 login/refresh/bash 三个 limiter。
- **方案**：加 `llmRevealLimiter()`，每用户每分钟 5 次，挂到 reveal 路径。
- **状态**：✓ 完成

### P0-2 · 容器内 LLM 环境变量注入 ✓
- **位置**：`sandbox-platform/src/services/container.service.ts`（create/start 流程 + toPublic）、`executors/{mock,ssh,apptainer-cli}-executor.ts`、`executors/types.ts`、`app.ts`
- **问题**：LLM virtual key 只到达 pi 宿主机 provider；容器内进程拿不到 key。探查还发现**三个执行器的 `create()` 全部丢弃 `req.env`**（既有缺口，不只影响 LLM），plain `start()` 也不传 env。
- **方案（已实施）**：
  1. executor 层：ssh/cli 的 `startInstance`/`runCli` 加 `--env KEY=VALUE`（值 shellQuote，key 名做 charset 校验防注入）；mock 的 create 持久化 env 到内部 handle map，exec 时合并；三执行器 `start()` 接收可选 env 参数。
  2. plain `start()`（container.service）从 `row.env` 读出传给 executor.create。
  3. service 层：`createContainerService` 加 `llmEnvFor?` 钩子；create 时若有 active binding，reveal key → 注入 `SANDBOX_LLM_BASE_URL`/`SANDBOX_LLM_API_KEY`（保留前缀，不碰用户命名空间；LLM env 覆盖用户同名值防绕过 budget）。
  4. `toPublic` 把 `*_KEY`/`*_TOKEN`/`*_SECRET` 变量 mask 成 `***`，GET 不回显明文。
- **测试**：container.lifecycle 新增 env 注入 + secret masking 测试（用户 env 进容器、API_KEY 在 GET 显示 `***`）。
- **状态**：✓ 完成

### P0-3 · 审计 retention 破坏链式哈希 ✓
- **位置**：`sandbox-platform/src/scheduler/reaper.ts`（`purgeAuditLogs`）、`src/services/log.service.ts`（hash 链）
- **问题**：reaper 的 `purgeAuditLogs` 直接 DELETE 老 `operation_logs` 行，但审计的 SHA-256 链依赖每行的 `prev_hash` 指向前一行。删行后链断裂，后续无法回溯验证完整性。
- **方案**：改为软删——给 `operation_logs` 加 `purged_at` 列（迁移），reaper 只 SET `purged_at=CURRENT_TIMESTAMP` 不 DELETE；链式验证跳过已 purged 的行（记录断点提示）。保留 retention 的存储回收目的（可后续物理清理 purged 且超长保留期的行，但单独标记）。
- **状态**：✓ 完成

### P0-4 · `/metrics` 端点鉴权 ✓
- **位置**：`sandbox-platform/src/app.ts`（`/metrics` 挂载）、`src/config.ts`
- **问题**：`GET /metrics` 无鉴权，任何人可拉 Prometheus 指标，泄露容器数、HTTP 路径分布、内部结构。
- **方案**：加可选配置 `METRICS_TOKEN`；设置后 `/metrics` 要求 `Authorization: Bearer <token>`，未设则保持开放（开发友好）。Prometheus 侧配对应 bearer。
- **状态**：✓ 完成

---

## P1 — 中优先（健壮性 / 一致性）

### P1-5 · LiteLLM client 幂等 GET 重试 ✓
- **位置**：`sandbox-platform/src/services/litellm.client.ts`（`request` 核心）
- **问题**：单次 `fetch` + `AbortController` 超时即返回 503。LiteLLM 一次网络抖动 = grantAccess/预算更新失败。无重试无熔断。
- **方案**：对幂等 GET（health/userinfo/listModels/listKeys/getSpendLogs/getSpendReport/getKeyInfo）加指数退避重试（2 次，如 200ms/800ms）；写操作（createUser/generateKey/deleteKey 等）保持单次，避免重复创建。
- **状态**：✓ 完成

### P1-6 · SshExecutor timedOut 语义对齐 ✓
- **位置**：`sandbox-platform/src/executors/ssh-executor.ts`（bash 超时）、`mock-executor.ts` / `apptainer-cli-executor.ts`（对照）
- **问题**：SshExecutor 的 bash 超时通过 `execOptions: { timeout } as never` 传给 node-ssh，**永远返回 `timedOut: false`**（硬编码）。用户在 SSH 执行器下跑超时命令得到错误的 timedOut 信号。另：mock 的 spawn error 是 resolve(exitCode -1)，cli 的是 reject，合约不一致。
- **方案**：SshExecutor 包一层自己的 timer + kill 信号，正确设置 `timedOut`。spawn error 合约统一为 resolve + exitCode -1（与正常非零退出一致），在 types.ts 注释明确。
- **状态**：✓ 完成（timedOut 对齐；spawn error 合约文档化）

### P1-7 · 幂等缓存多实例失效 ✗
- **位置**：`sandbox-platform/src/routes/containers.routes.ts`（`idempotencyCache` 模块级 Map）
- **问题**：进程内 Map，多实例/负载均衡部署时各进程独立，相同 Idempotency-Key 在不同实例会重复创建容器。
- **方案候选**：① 挪进 DB 表（`idempotency_keys` 带 TTL）；② Redis；③ 文档化"单实例限制"。
- **状态**：✗ 跳过（当前 MVP 单实例部署，多实例是未来调度器范畴；在 README 注明单实例限制即可，避免过度设计）

### P1-8 · 扩展 refresh() 区分网络错/401 ✓
- **位置**：`pi-sandbox-extension/lib/client.ts`（`refresh`）
- **问题**：`catch { return false }` 把网络错误和真正的 401 都吞掉，用户只看到"401 重试失败"无诊断。
- **方案**：区分 `PlatformError`（refresh 端点 401 → refresh token 失效，提示重新登录）与网络错误（提示"平台不可达"）。
- **状态**：✓ 完成

### P1-9 · web 前端零测试 ✓
- **位置**：`sandbox-platform/web/test/client.test.ts`
- **方案**：引入 vitest（与后端对齐 2.1.8），优先覆盖 `api/client.ts` 的两个回归高风险点：`qs()`（过滤 undefined/空串，防 URLSearchParams 踩坑）和 `request()`（401 自动刷新+重试、204 处理、ApiError 映射）。fetch 全局 mock，无需 DOM/jsdom。13 个测试。
- **状态**：✓ 完成（client 层；React 组件测试如 RevealButton 状态机留作后续）

### P1-10 · 两个真实执行器零测试 ✓（命令构造层）
- **位置**：`sandbox-platform/test/executors.test.ts`、`src/executors/shell-quote.ts`
- **方案**：把 ssh/cli 执行器的命令构造抽成可测纯函数（`envOpts`/`envArgs`/`shellQuote`/`isValidEnvName`，共享 `shell-quote.ts` 消除重复），单测覆盖 env 注入的注入防护（畸形 key 名跳过、值含 shell 元字符安全引用）。15 个测试。
- **状态**：✓ 完成（命令构造/注入防护层；node-ssh 集成测试 + 真实 apptainer smoke 需 Linux CI，留作后续）

### P1-11 · LLM_ENCRYPTION_KEY 不可轮换且无工具 ✓
- **位置**：`sandbox-platform/scripts/rotate-llm-key.ts`
- **方案**：`scripts/rotate-llm-key.ts` + `npm run rotate-llm-key`，遍历 `llm_virtual_keys` 用旧密钥解密、新密钥重新加密；支持 `--old/--new` 或 `LLM_OLD_KEY/LLM_NEW_KEY`、`--dry-run`、per-row 失败隔离。
- **状态**：✓ 完成（E2E 验证：插入→轮换→新密钥解密成功）

---

## P2 — 低优先（体验 / 技术债）

### P2-12 · console.warn → logger.warn ✓
- **位置**：`sandbox-platform/src/services/container.service.ts:256`、`workspace.service.ts`、`log.service.ts`
- **问题**：审计写入失败用 `console.warn` 而非 logger，绕过 pino 结构化输出（且需 eslint-disable）。
- **方案**：替换为 `logger.warn`。
- **状态**：✓ 完成

### P2-13 · unhandledRejection 钩子 ✓
- **位置**：`sandbox-platform/src/index.ts`
- **问题**：无 `process.on("unhandledRejection"/"uncaughtException")` 钩子，未捕获异常丢失诊断。
- **方案**：加进程级错误日志钩子，记录后再退出。
- **状态**：✓ 完成

### P2-14 · Prometheus 指标覆盖窄 ✓
- **位置**：`sandbox-platform/src/middleware/metrics.ts`
- **方案**：`containers_running` → `containers_by_status`（per-status gauge，每 scrape reset+set）；新增 `users_total`、`workspaces_total` gauge、`reaper_reclaimed_total` counter（reaper 上报）、`litellm_health` gauge（/ready 上报）。
- **状态**：✓ 完成

### P2-15 · engines.node 过低 ✓
- **位置**：`sandbox-platform/package.json`
- **问题**：`>=18.18.0`，Node 18 已 EOL（2025-04）。
- **方案**：提到 `>=20.11.0`。
- **状态**：✓ 完成

### P2-16 · 扩展无 typecheck scripts ✓
- **位置**：`pi-sandbox-extension/package.json`
- **问题**：无 scripts/engines/devDeps，扩展无法独立类型检查。
- **方案**：加 `"scripts": { "typecheck": "tsc --noEmit" }`、engines、devDeps（typescript + pi-coding-agent）。注：扩展零构建（jiti 即时编译），typecheck 仅作开发期校验。
- **状态**：✓ 完成（注：受限于 pi 包未发布到 npm，完整 tsc 需在 pi monorepo 内运行；这里补 scripts 框架 + engines）

### P2-17 · workspace sync 全量无增量 ☐
- **位置**：`pi-sandbox-extension/lib/sync.ts`
- **问题**：顺序上传每个文件，无 mtime/size diff，重跑全传。大项目慢。
- **方案**：记录已 sync 文件的 `(rel, size, mtime)` 到 `.pi/sandbox-sync.json`，增量上传；有限并发（4）。
- **状态**：☐ 待办

### P2-18 · 两份 docs 过时标注 ✓
- **位置**：`docs/项目架构图.md`、`docs/Apptainer轻量用户手册.md` §5
- **方案**：架构图快照状态机改为 Stop-Then-Copy、移除 SNAP/WS partial 红标；手册 §5 从"当前均缺失"改为"已实现"，补 reaper 配置项 + 软删说明。
- **状态**：✓ 完成

---

## 文档缺口（未写，按需补）

| # | 文档 | 说明 | 状态 |
|---|------|------|------|
| D-1 | 端到端用户指南 | 串联平台→容器→扩展→LLM 的使用流程，管理员 + 普通用户视角 | ✓（`docs/USER-GUIDE.md`）|
| D-2 | REST API 完整参考 / OpenAPI | 目前只有一张不完整的端点表 | ☐ |
| D-3 | 生产部署 runbook | 反代/TLS/systemd/监控/备份演练/RPO-RTO | ☐ |
| D-4 | 统一 Troubleshooting | 跨组件故障排查（登录/容器/LLM/镜像/同步） | ✓（`docs/USER-GUIDE.md` FAQ 章节）|
| D-5 | CONTRIBUTING / CHANGELOG / LICENSE | 开源标配 | ☐ |
| D-6 | ADR（架构决策记录） | "为何自建 DAL""为何 LiteLLM 独立 PG""为何 overlay 伪快照" | ☐ |
