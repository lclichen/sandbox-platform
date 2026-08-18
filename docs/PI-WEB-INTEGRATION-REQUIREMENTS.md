# pi-web 集成需求（沙箱平台侧）

> 状态：需求稿，待补充实现。关联：pi-web 仓库 `docs/multi-user-and-modes-design.md`。
> 背景：pi-web（Next.js Web UI）将作为平台的多用户前端门户：登录依托平台账号，沙箱模式会话的工具经 `pi-sandbox-extension` 打到用户容器。本文件列出平台侧需要补充/调整的需求；其余现状能力（JWT/API Key、owner 隔离、配额、审计、快照、workspaces）已满足 P0 需要。

## R1 用户自注册（P0.5）

现状：账号只能由管理员经 `POST /api/v1/admin/users` 创建。

需求：
- 新增公共端点 `POST /api/v1/auth/register`（username/password/email），受开关控制：
  - `REGISTER_MODE=off`（默认）：返回 404，行为与现状一致。
  - `REGISTER_MODE=open`：直接建号，套用默认配额模板（可配置引用某个 `resource_quotas` 行）。
  - `REGISTER_MODE=approval`：建号为 `pending` 状态，管理员在 Web 控制台审批后激活。
- 用户名冲突、密码策略（最小长度/复杂度，env 可配）、注册接口独立速率限制与验证码位（可先留接口）。
- 管理控制台 Users 页增加：批量导入（CSV）、审批队列。

验收：三种模式下注册行为正确；pending 用户登录被拒且提示明确；限流生效。

## R2 容器交互终端 WebSocket（P1）

现状：交互式执行只有 SSE `POST /tools/bash/stream`（一次性命令流），无 PTY。

需求：
- `GET /api/v1/containers/:id/pty`（WebSocket 升级）：桥接 `apptainer exec instance://<id> bash`（node-pty 或等价），owner 鉴权沿用 `requireOwned`。
- 帧协议（与 pi-web 现有终端一致，降低前端成本）：
  - 服务端 → 客户端：`{type:"ready"}` / `{type:"output", data}` / `{type:"exit", code}`。
  - 客户端 → 服务端：`{type:"input", data}` / `{type:"resize", cols, rows}`。
- 每容器并发 PTY 上限（默认 3，env 可配）；空闲回收（无连接 30 分钟 kill）；连接写入现有 `sessions` 审计表。
- MockExecutor 提供可测试的假 PTY（回显），保持 win32 可测。

验收：pi-web xterm 前端直连该端点完成输入/输出/resize/退出横幅；越权容器 404；上限与回收生效；vitest 覆盖 Mock 路径。

## R3 部署形态与运维（P0 前置评审）

现状：单机直跑（端口 3000），HTTPS/反代/服务化文档未成体系。

需求：
- 反向代理部署指南（Nginx/Caddy 示例：WebSocket 升级头、SSE 不缓冲、超时配置）；可选路径前缀挂载（`/sandbox/`）说明。
- systemd 单元模板 + `EXECUTOR_KIND=ssh` 生产参数清单（rootless Apptainer、目录权限、密钥文件位置）。
- 与 pi-web 的两种拓扑（同机反代 / 分机）说明及端口矩阵。
- 健康探针接入门槛说明（现有 `/health` `/ready` 基础上补 docker/systemd watch 文档）。

验收：按文档在干净 Linux 主机完成一次带 HTTPS 的部署，pi-web 登录与工具链路全通。

## R4 模型网关降级为可选（P0）

现状：`LLM_ENABLED` 存在但相关注入逻辑与文档耦合较深；pi-web 侧决定**关闭模型密钥自动分配**（网关后期可能不上线）。

需求：
- `LLM_ENABLED` 默认 `false`；关闭时：创建容器**不注入**任何 `SANDBOX_LLM_*` 环境变量；`/api/v1/llm/*` 路由整组返回 501（而非隐式报错）；`pi-sandbox-extension` 的 LLM provider 注册在无网关配置时完全跳过（不弹提示、不阻塞会话启动）。
- 文档标注 LiteLLM 为可选组件，README 快速开始不再暗示其必选。

验收：`LLM_ENABLED` 未设置时全新部署，创建容器 env 无 LLM 变量、扩展无网关报错、现有测试全绿。

## R5 workspaces API 增强（P1）

现状：`/api/v1/workspaces` 支持 CRUD + 上传下载列表删除，但目录树需逐层拉取，大文件整包传输。

需求：
- `GET /workspaces/:id/tree`：一次返回递归树（带深度上限与分页游标；忽略清单可配，默认跳过 `node_modules/.git/dist/build`）。
- 上传分块（`POST /workspaces/:id/files?uploadId=&part=` + complete）或至少流式直传；单文件上限 env 可配。
- 目录重命名/移动端点。
- （P2）workspace 共享 ACL：按用户只读/读写授权，用于教师下发材料。

验收：pi-web 沙箱模式文件树首屏一次请求完成；10MB 文件上传在弱网可续传（分块方案时）。

## R6 容器选择与自动供给配置（P1）

现状：自动供给固定取首个公共镜像；容器列表无过滤参数。

需求：
- `GET /api/v1/containers?filter=running&image=<id>` 过滤参数。
- 每用户/每配额可选镜像白名单（默认全部公共镜像）。
- 平台级配置默认供给镜像与 `seedFromPath` 模板（例如统一的教学基础镜像 + 初始文件），供 pi-web 沙箱会话"一键开箱"。

验收：pi-web 会话设置的容器选择器数据一次拉取；新用户首次会话按默认镜像开箱。

## R7 稳定性与错误语义（P0 前置评审）

现状：幂等缓存等内存态为进程局部（IMPROVEMENTS P1-7 已知）；错误响应以文案为主。

需求：
- 错误响应统一附带稳定 `code` 字段（如 `QUOTA_EXCEEDED`、`CONTAINER_NOT_RUNNING`），文档列出全量码表；pi-web 据此做本地化与重试策略。
- SSE `bash/stream` 断线语义文档化（是否可续、幂等性）。
- 单实例约束在 README 明示；多实例部署时的失效面清单。

验收：码表入 `docs/API-REFERENCE.md`；主要路径（鉴权、配额、容器生命周期）错误均带 code。

## R8 用量与审计补充（P2）

需求（网关关闭后的替代口径）：
- 按容器/用户的工具调用量（次数、字节数、活跃时长）日汇总表 + 管理台报表。
- 现有审计哈希链保持不变，仅增汇总视图。

验收：管理台可按用户/时间窗导出 CSV。

## R9 安全补充（P1）

- 密码策略与首次登录强制改密（admin 创建的账号）。
- 注册垃圾请求防护（R1 联动：限流 + 可选邮箱验证链接位）。
- （P2）TOTP 两步验证。

## 优先级总览

| 需求 | 阶段 | 备注 |
|---|---|---|
| R3 部署、R7 稳定性、R4 网关降级 | P0 前置 | 保证 pi-web P0 门户化可依赖 |
| R1 自注册 | P0.5 | 教学批量开课需要 |
| R2 PTY WS、R5 workspaces、R6 容器选择 | P1 | 对应 pi-web P1 |
| R8 用量、R9 安全增强、ACL | P2 | 后续迭代 |
