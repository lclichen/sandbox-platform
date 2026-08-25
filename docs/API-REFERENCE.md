# API 参考：错误码表 / SSE 语义 / 单实例约束 / pi-web 新端点

> 面向 pi-web 与 pi-sandbox-extension 的对接契约。所有错误响应形如
> `{ "code": "<STABLE_CODE>", "message": "<human readable>", "details"?: ... }`，
> `code` 是稳定的大写蛇形机器码——前端据其做本地化与重试策略；
> **已发布的 code 不会被重命名**（弃用时保留旧码并新增新码）。

## 1. 错误码全量表

### 1.1 通用错误

| code | HTTP | 含义 | 建议前端行为 |
|---|---|---|---|
| `BAD_REQUEST` | 400 | 参数校验失败（`details` 列出字段级问题） | 提示修正输入 |
| `WEAK_PASSWORD` | 400 | 密码不满足策略（长度/复杂度，env 可配） | 引导强密码 |
| `UNAUTHORIZED` | 401 | 未带凭证 / token 失效 / API key 吊销 | 刷新 token 或重新登录 |
| `FORBIDDEN` | 403 | 已认证但权限不足（如非 admin 访问 admin 端点） | 隐藏入口 |
| `ACCOUNT_PENDING` | 403 | 账号待管理员审批（approval 注册模式） | 提示等待审批 |
| `ACCOUNT_DISABLED` | 403 | 账号被禁用 | 提示联系管理员 |
| `PASSWORD_CHANGE_REQUIRED` | 403 | 首次登录强制改密（R9），改密前仅 `/auth/me`、`/auth/change-password`、`/auth/logout`、`/auth/refresh` 可达 | 路由到改密表单 |
| `IMAGE_NOT_ALLOWED` | 403 | 镜像不在所属配额的白名单（R6） | 收窄镜像选择器 |
| `NOT_FOUND` | 404 | 资源不存在 **或** 越权访问（不泄露存在性） | — |
| `CONFLICT` | 409 | 唯一性冲突（用户名/镜像名/工作区名/快照名） | 提示换名 |
| `INVALID_STATE` | 409 | 状态机不允许（如 stop 一个 stopped 容器、审批非 pending 用户） | 刷新状态 |
| `CONTAINER_NOT_RUNNING` | 409 | 容器未运行（工具/PTY 需要运行态） | 提供"启动容器"操作 |
| `QUOTA_EXCEEDED` | 422 | 配额超限（容器数/CPU/内存/磁盘/工作区数/聚合磁盘，`details.limit` 给上限） | 提示升级配额 |
| `RATE_LIMITED` | 429 | 触发限流（登录/注册/bash/LLM reveal） | 按 `Retry-After` 退避 |
| `INTERNAL_ERROR` | 500 | 服务端错误（生产环境 message 脱敏） | 重试一次后上报 |
| `LLM_NOT_ENABLED` | 501 | LLM 网关未部署（`LLM_ENABLED=false`，默认） | **永久跳过**，不要重试 |

### 1.2 PTY WebSocket（升级阶段以 HTTP 状态返回，连接期以 close code 返回）

| code | HTTP / close code | 含义 |
|---|---|---|
| `UNAUTHORIZED` | HTTP 401 | 缺少 `?token=` 或凭证无效 |
| `NOT_FOUND` | HTTP 404 | 容器不存在或非本人容器 |
| `CONTAINER_NOT_RUNNING` | HTTP 409 | 容器未运行 |
| `PTY_LIMIT_REACHED` | HTTP 429 | 超过 `PTY_MAX_PER_CONTAINER` 并发上限 |
| `PTY_NOT_SUPPORTED` | HTTP 501 | 当前执行器不支持终端 |
| （close code） | 1000 | shell 正常退出（此前已发 `{type:"exit"}` 帧） |
| （close code） | 4000 | 空闲超时被回收（`PTY_IDLE_TIMEOUT_MINUTES`） |
| （close code） | 4400 | 客户端发送了非法帧（二进制/坏 JSON/未知 type） |
| （close code） | 1011 | 服务端打开 PTY 失败 |

### 1.3 LLM 集成错误（可选组件，网关启用时才会出现）

| code | HTTP | 含义 |
|---|---|---|
| `QUOTA_EXCEEDED` | 422 | LiteLLM budget 超额（400 + `budget_exceeded` 映射） |
| `RATE_LIMITED` | 429 | LiteLLM TPM/RPM/并发限流 |
| `LLM_UNREACHABLE` / `LLM_TIMEOUT` | 503 | 网关不可达 / 超时（GET 自动重试 2 次） |
| `LLM_BAD_RESPONSE` / `LLM_ERROR` | 502 | 网关返回异常结构 |
| `LLM_NOT_CONFIGURED` / `DECRYPT_FAILED` | 500 | 平台侧加密配置问题（检查 `LLM_ENCRYPTION_KEY`） |

## 2. SSE `bash/stream` 断线语义

- **协议**：`POST /api/v1/containers/:id/tools/bash/stream`，body 同
  `POST .../bash`；响应为 `text/event-stream`，事件按序：
  `data`（多帧，base64 chunk）→ `end`（`{exitCode, timedOut}`）或 `error`
  （`{message, code, status}`）。
- **不可续传**：断线即丢流。命令仍在容器内继续执行直到自然结束或超时——SSE
  只是把输出转发给客户端，断开不会 kill 进程。
- **不可重放**：重发同一请求会**再执行一次**命令。需要幂等语义的调用方应自带
  幂等层（容器创建已支持 `Idempotency-Key`，bash 不支持）。
- **语义状态码**：因为 headers 已按 200 发出，业务错误在 `error` 事件里携带
  `code`/`status`（同第 1 节码表），客户端应据此重建错误对象。
- **代理要求**：见 `docs/DEPLOYMENT.md` §1（关闭缓冲、拉长读超时）。

## 3. 单实例约束（重要）

以下状态是**进程内存态**，只支持单实例部署（默认形态）：

| 状态 | 位置 | 多实例失效面 |
|---|---|---|
| 容器创建幂等缓存（`Idempotency-Key`，5 分钟 TTL） | `routes/containers.routes.ts` | 重试打到另一实例会重复建容器 |
| PTY 并发计数（每容器上限） | `routes/pty.ts` | 上限按实例分别计数，实际连接数 = N × 上限 |
| 限流计数器 | `express-rate-limit` 内存 store | 每 IP 实际限额 = N × 配置 |
| 分块上传会话（part 文件 + meta） | `WORKSPACE_BASE_DIR/.uploads/`（磁盘） | 仅在共享文件系统 + 粘性路由下可跨实例 |
| Mock 执行器句柄表 | `executors/mock-executor.ts` | 仅开发态，无生产影响 |

要横向扩展，前置条件：PostgreSQL 后端、Redis 限流/幂等 store、共享 overlay
文件系统与粘性路由——当前版本未内置，**请保持单实例**，用更大的单机垂直扩容。
空闲回收（reaper）与审计清理也在进程内定时运行，多实例会重复扫描（幂但浪费）。

## 4. pi-web 集成新增端点速览

### R1 自注册（`REGISTER_MODE` 控制）

| 端点 | 说明 |
|---|---|
| `GET  /api/v1/auth/config` | 公开；`{registerMode: "off"\|"open"\|"approval"}`，登录页据此显示注册入口 |
| `POST /api/v1/auth/register` | `{username, password, email?}`；off→404，open→201 active，approval→201 pending |
| `GET  /api/v1/admin/users?status=pending` | 审批队列（admin） |
| `POST /api/v1/admin/users/:id/approve` / `:id/reject` | 审批 / 拒绝（reject 删除账号） |
| `POST /api/v1/admin/users/import` | `{csv, mustChangePassword?, quota_id?}`；CSV 每行 `username,password[,email]`，返回逐行结果 |

### R2 容器终端（WebSocket）

`GET /api/v1/containers/:id/pty?token=<JWT|sk_ key>`，帧协议：

```jsonc
// server → client
{"type":"ready"}
{"type":"output","data":"<utf8>"}
{"type":"exit","code":0}
// client → server
{"type":"input","data":"ls\r"}
{"type":"resize","cols":120,"rows":40}
```

### R5 workspaces

| 端点 | 说明 |
|---|---|
| `GET  /api/v1/workspaces/:id/tree?path=&depth=&cursor=` | 一次递归树；默认忽略 `node_modules,.git,dist,build`（`WORKSPACE_TREE_IGNORE`）；`truncated=true` 时带 `nextCursor` 续拉 |
| `POST /api/v1/workspaces/:id/files/move` | `{path, to}`；`to` 为新全路径，或以 `/` 结尾表示目标目录（mv 语义） |
| `POST /api/v1/workspaces/:id/uploads?path=` | `{name, size?}` → `{uploadId, partBytesMax, maxBytes}` |
| `PUT  /api/v1/workspaces/:id/uploads/:uid?part=N` | 原始字节体；乱序可续传 |
| `POST /api/v1/workspaces/:id/uploads/:uid/complete` | 拼装落盘（配额/大小校验在此发生） |
| `DELETE /api/v1/workspaces/:id/uploads/:uid` | 中止并清理 |

### R6 容器选择

| 端点 | 说明 |
|---|---|
| `GET /api/v1/containers?filter=running&image=<id>` | 过滤参数（`filter`: running/stopped/all） |
| `GET /api/v1/provision/defaults` | 一键开箱默认值 `{imageId, imageName, workspaceId, workspaceName}`（env：`PROVISION_DEFAULT_IMAGE_ID` / `PROVISION_DEFAULT_WORKSPACE_ID`） |
| 配额 `allowed_image_ids` | admin 配额接口新增字段；null/空 = 全部公共镜像 |

### R9 强制改密

| 端点 | 说明 |
|---|---|
| `POST /api/v1/auth/change-password` | `{currentPassword, newPassword}`；成功后吊销全部 refresh token |
| 登录响应 `user.must_change_password` | 为 true 时前端应进入改密流程；期间其它端点 403 `PASSWORD_CHANGE_REQUIRED` |
