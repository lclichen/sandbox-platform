# 限流与资源上限速查（2026-11）

本文件集中列出 `sandbox-platform` 的请求限流、资源上限及对应环境变量。
**除特别注明外，所有值在进程启动时从环境变量读取，修改后需重启平台。**
`WORKSPACE_UPLOAD_MAX_BYTES` 还支持管理员通过 `PUT /api/v1/admin/limits`
在运行时覆盖（见 §4）。

## 1. HTTP 限流（按客户端 IP，60 秒窗口）

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `RATE_LIMIT_ENABLED` | `true` | 总开关；生产环境建议必须为 true |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | 10 | `POST /api/v1/auth/login` |
| `RATE_LIMIT_REFRESH_PER_MINUTE` | 30 | `POST /api/v1/auth/refresh` |
| `RATE_LIMIT_REGISTER_PER_MINUTE` | 5 | `POST /api/v1/auth/register` |
| `RATE_LIMIT_OIDC_PER_MINUTE` | 300 | `/api/v1/auth/oidc/*`（begin/callback/exchange） |
| `RATE_LIMIT_CHANGE_PASSWORD_PER_MINUTE` | 5 | `POST /api/v1/auth/change-password` |
| `RATE_LIMIT_BASH_PER_MINUTE` | 60 | `POST /api/v1/containers/:id/tools/bash` 及其 `/stream` |
| `RATE_LIMIT_LLM_REVEAL_PER_MINUTE` | 5 | `POST /api/v1/llm/me/keys/:id/reveal` |

实现：`express-rate-limit`；触发时返回 HTTP 429，body
`{"code":"RATE_LIMITED","message":"..."}`。限流中间件在 `express.json`
之前执行，未认证的超大 JSON body 不会先被解析。

## 2. HTTP 请求体

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `HTTP_JSON_BODY_LIMIT` | `16mb` | `express.json` 的 JSON body 上限（支持 `16mb`/字节数） |

工作区单文件上传走 octet-stream 流式路径，**不受** `HTTP_JSON_BODY_LIMIT`
限制；其上限是 `WORKSPACE_UPLOAD_MAX_BYTES`。

## 3. 工具中继（tools）

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `TOOLS_READ_MAX_BYTES` | 2097152（2 MiB） | `read` 单文件上限，超过返回 413 `FILE_TOO_LARGE` |
| `TOOLS_GREP_MAX_PATTERN_CHARS` | 1000 | grep 正则最大字符数，超过返回 400 `PATTERN_TOO_LONG` |
| `TOOLS_GREP_MAX_LINE_CHARS` | 10000 | grep 参与匹配的单行最大字符数（截断后再匹配） |
| `TOOLS_WALK_MAX_FILES` | 20000 | 一次 grep/find 最多访问的文件数 |
| `TOOLS_WALK_MAX_DEPTH` | 32 | grep/find 目录递归最大深度 |
| `TOOLS_WALK_TIMEOUT_MS` | 60000（1 分钟） | 一次 grep/find 的时间预算；`0` 表示不限制 |
| `TOOLS_BASH_OUTPUT_MAX_BYTES` | 8388608（8 MiB） | 单次 bash stdout+stderr 缓冲上限；超限 kill 并返回 `truncated: true` |
| `TOOLS_BASH_MAX_TIMEOUT_SECONDS` | 3600 | 客户端可请求的 bash 超时上限；超过返回 400 `TIMEOUT_TOO_LARGE` |

补充（固定值，不通过环境变量）：

- `bash` 请求 schema 的绝对上限是 **86400 秒**（7 天）；实际更小的限制由
  `TOOLS_BASH_MAX_TIMEOUT_SECONDS` 决定。
- grep/find 的 `limit` 参数范围 **1–1000**（默认 100）。
- grep 正则先经过 `safe-regex2` 检查，可能返回 400 `UNSAFE_PATTERN`。
- grep/find 到达时间/文件/深度预算时返回**已得到的部分结果**（当前响应没有
  单独的 truncated 标志）。

## 4. 工作区上传 / 下载 / 树

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `WORKSPACE_UPLOAD_MAX_BYTES` | 2147483648（2 GiB） | 单文件上限（直传与分块合并共用） |
| `WORKSPACE_UPLOAD_PART_MAX_BYTES` | 8388608（8 MiB） | 分块上传单个 part 上限 |
| `WORKSPACE_TREE_MAX_DEPTH` | 32 | `GET /workspaces/:id/tree` 允许的最大 depth |
| `WORKSPACE_TREE_MAX_ENTRIES` | 5000 | 单次 tree 请求最多返回条数 |
| `WORKSPACE_EXPORT_MAX_BYTES` | 536870912（512 MiB） | `export-workspace` 打包 tar.gz 的内存缓冲上限 |
| `WORKSPACE_UPLOAD_TTL_HOURS` | 24 | 未完成分块上传的清理时长 |
| `WORKSPACE_TREE_IGNORE` | `node_modules,.git,dist,build` | tree 跳过的目录名（非数值上限） |

行为说明：

- 直传（`POST /workspaces/:id/files`）和分块合并都**流式落盘**，不会把 2 GiB
  文件整体读入内存；分块合并时逐 part 读取。
- 下载（`GET /workspaces/:id/files/content`）使用流式 `sendFile`，支持 Range。
- 超过 `WORKSPACE_UPLOAD_MAX_BYTES` 返回 413 `UPLOAD_TOO_LARGE`（上传）或
  413 `FILE_TOO_LARGE`（下载/导出）。
- 运行时覆盖：`PUT /api/v1/admin/limits` body
  `{"workspaceUploadMaxBytes": <bytes|null>}`；`null` 恢复环境变量默认值。
  运行时覆盖的合法范围是 **1 MiB – 64 GiB**。

## 5. PTY 终端（WebSocket）

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `PTY_MAX_PER_CONTAINER` | 3 | 每容器并发 PTY 会话数 |
| `PTY_IDLE_TIMEOUT_MINUTES` | 30 | 无客户端流量的空闲回收时间 |
| `PTY_MAX_FRAME_BYTES` | 1048576（1 MiB） | 单个 WebSocket frame 上限 |
| `PTY_INPUT_BYTES_PER_SECOND` | 262144（256 KiB） | 每会话每秒输入预算 |
| `PTY_INPUT_BYTES_TOTAL` | 104857600（100 MiB） | 每会话生命周期输入预算 |

补充：服务端每 30 秒 ping 一次；ticket 有效期固定 60 秒且单次使用。

## 6. 容器输入/输出挂载

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `CONTAINER_MAX_INPUT_MOUNTS` | 32 | 每容器输入挂载项数 |
| `CONTAINER_MAX_INPUT_BYTES` | 1073741824（1 GiB） | 每容器输入物化总字节数 |

## 7. 认证与会话

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `JWT_ACCESS_TTL` | `15m` | access token 有效期 |
| `JWT_REFRESH_TTL` | `7d` | refresh token 有效期 |
| `PASSWORD_MIN_LENGTH` | 8 | 密码最小长度 |
| `PASSWORD_REQUIRE_COMPLEXITY` | `false` | 是否要求大小写+数字 |
| `OIDC` 发现/JWKS/token 请求超时 | 10 秒（固定） | 出站 OIDC 请求超时 |

固定值：每个用户最多 **50 个活跃 API key**；密码 bcrypt cost 12；
PTY ticket 60 秒；OIDC handoff code 60 秒。

## 8. 其他运行参数（非请求上限，但常一起调整）

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `AGENTGATEWAY_TIMEOUT_MS` | 30000 | LLM 网关 admin API 超时 |
| `REAPER_INTERVAL_MINUTES` | 30 | 空闲回收扫描间隔 |
| `IDLE_AUTO_STOP_HOURS` | 168 | 容器空闲自动回收阈值 |
| `AUDIT_RETENTION_DAYS` | 90 | 审计日志保留天数（0 关闭清理） |

## 9. 调整示例

```bash
# 2 GiB 单文件，grep/find 2 分钟，OIDC 500 次/分钟
WORKSPACE_UPLOAD_MAX_BYTES=2147483648 \
TOOLS_WALK_TIMEOUT_MS=120000 \
RATE_LIMIT_OIDC_PER_MINUTE=500 \
npm start
```

修改 `.env` 后重启进程生效；`WORKSPACE_UPLOAD_MAX_BYTES` 也可在管理台通过
`PUT /api/v1/admin/limits` 热更新。
