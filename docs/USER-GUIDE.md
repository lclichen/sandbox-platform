# AgentSandbox 使用指南

本指南面向**最终用户**——平台管理员和普通开发者。覆盖 Web 控制台和 pi CLI 扩展的全部日常操作。

> 开发/部署/二次开发请看 [`AGENTS.md`](../AGENTS.md)。运维手册看 [`Apptainer轻量用户手册.md`](Apptainer轻量用户手册.md)。

---

## 目录

- [快速开始](#快速开始)
- [管理员指南](#管理员指南)
  - [管理用户](#管理用户)
  - [管理配额](#管理配额)
  - [管理镜像](#管理镜像)
  - [查看审计日志](#查看审计日志)
  - [管理 LLM 访问](#管理-llm-访问管理员)
- [普通用户指南](#普通用户指南)
  - [用 pi 扩展开发](#用-pi-扩展开发)
  - [用 Web 控制台](#用-web-控制台)
  - [LLM（大模型）使用](#llm大模型使用)
- [故障排查 FAQ](#故障排查-faq)

---

## 快速开始

### 我是什么角色？

| 你做的事 | 你的角色 | 主要工具 |
|----------|---------|---------|
| 部署平台、管用户/配额/镜像、给同事开账号 | **管理员** | Web 控制台 |
| 在沙盒容器里写代码、跑 agent | **普通用户** | pi CLI 扩展 + Web 控制台 |

### 第一次使用

**管理员**：部署完成后（问部署者要平台地址），用浏览器打开平台首页，用初始账号登录：

```
地址：http://<平台地址>:3000
用户名：admin
密码：changeme123
```

⚠️ **首次登录后立刻改密码**（Users 页 → 选 admin → 设置密码）。`changeme123` 在生产环境会被拒绝启动，部署者应该已改成强密码——问他要真实密码。

**普通用户**：找管理员要一个账号和平台地址，然后：
1. 装 pi 和 sandbox 扩展（见下文[用 pi 扩展开发](#用-pi-扩展开发)）
2. `/sandbox-login` 登录
3. 开始写代码

---

## 管理员指南

管理员通过 **Web 控制台**（左侧导航的 Administration 区）管理平台。普通用户的功能你也能用（容器、工作区等），额外多出以下管理功能。

### 管理用户

**入口**：左侧导航 → **Users**（仅管理员可见）

| 操作 | 怎么做 |
|------|--------|
| 创建用户 | 点 "+ New user"，填用户名/密码/邮箱，选角色（user/admin）和配额 tier |
| 改密码 | 选用户 → "Set password" |
| 启用/禁用 | 选用户 → 改 Status 为 active/disabled（禁用后用户立即无法登录） |
| 改角色 | 选用户 → 改 Role（user ↔ admin） |
| 分配配额 | 选用户 → 改 Quota（决定该用户能开多少容器/CPU/磁盘） |
| 删除用户 | 选用户 → Delete（用户的容器、工作区、key 会级联删除） |

**配额 tier** 决定用户能用的资源上限，见[管理配额](#管理配额)。

### 管理配额

**入口**：左侧导航 → **Quotas**（仅管理员可见）

配额是"资源套餐"，每个用户绑定一个 tier。系统预置三个：

| Tier | 容器数 | CPU 核 | 内存 | 磁盘 | 快照/容器 | 工作区 |
|------|--------|--------|------|------|----------|--------|
| default | 2 | 2 | 2GB | 10GB | 5 | 10 |
| admin | 10 | 8 | 16GB | 50GB | 20 | 50 |
| enterprise | 20 | 16 | 32GB | 100GB | 50 | 100 |

- **新建/编辑 tier**：点 "+ New quota" 或选某行编辑，调整各项上限。
- **聚合磁盘配额**：用户的所有容器 overlay + 快照体积总和不能超过 tier 的磁盘上限——创建快照时会校验。
- 删除 tier 前需确认没有用户绑定它。

### 管理镜像

**入口**：左侧导航 → **Images**

镜像是容器的基础（Apptainer SIF 文件）。系统预置三个示例镜像（ubuntu-22.04 / node-20 / python-3.12），但它们的 `sif_path` 指向服务器路径——**实际使用前需在服务器上放好真实 SIF 文件**。

| 字段 | 说明 |
|------|------|
| name | 镜像标识（如 `ubuntu-22.04`），创建容器时引用 |
| display_name | 显示名 |
| sif_path | 服务器上 SIF 文件的真实路径（如 `/srv/apptainer/images/ubuntu-22.04.sif`） |
| is_public | 勾选后普通用户能在列表看到并基于它建容器 |
| default_resources | 基于此镜像建容器时的默认 CPU/内存/磁盘 |
| tags | 标签（便于分类） |

> ⚠️ 把 SIF 文件丢进服务器的某个目录**不会**自动出现在镜像列表——镜像列表来自数据库。必须在 Images 页新增一条记录，填好 `sif_path`。详见[镜像列表 FAQ](#镜像列表里没有我刚放的-sif-文件)。

### 查看审计日志

**入口**：左侧导航 → **Logs**

所有写操作（创建/删除/启动/停止/授权等）自动记录。支持按用户、动作、资源类型、资源 ID、状态过滤。

- 普通用户只能看自己的日志（Logs 页对自己的操作可见）。
- 日志带 SHA-256 链式哈希防篡改；超期日志软删（保留可审计性，不在列表显示）。

管理员还能在 **Dashboard** 看全局统计：用户数、运行中容器数、24h 失败数、容器状态分布。

### 管理 LLM 访问（管理员）

如果平台启用了 LLM 集成（LiteLLM 网关），管理员负责给用户开通大模型访问权限。

**入口**：左侧导航 → **LLM**（仅管理员可见，未启用时显示"LLM integration is not enabled"）

| 操作 | 怎么做 |
|------|--------|
| 授权用户 | "Grant access" → 选用户 → 设月度预算（USD）+ 重置周期（如 `1d`/`30d`）+ 允许的模型（留空=全部）。授权时会自动发一个初始 virtual key，**明文只显示这一次**，复制给用户。 |
| 改预算 | 选用户 → Edit → 调整 max_budget / budget_duration / 模型列表 |
| 吊销访问 | 选用户 → Revoke（会删除该用户在 LiteLLM 的账号和所有 key，立即失效） |
| 查看用量 | 选用户 → 查 spend / 预算用量；或在 "Access bindings" tab 看全局 |
| 看可用模型 | 切到 "Models" tab（来自 LiteLLM 的模型列表） |

**预算硬限在 LiteLLM 侧**：用户超额后 LLM 请求会被 LiteLLM 拒绝（返回 budget_exceeded），平台只读展示用量。重置周期到期后预算自动恢复。

给用户开通后，告诉他们：
1. 平台地址
2. 他们被授权了（让他们 `/sandbox-login` 后扩展会自动配置 LLM，或在 Web 的 "LLM keys" 页拿 key）

---

## 普通用户指南

### 用 pi 扩展开发

这是开发者的主要工作方式：pi coding agent 在你本地跑，但文件读写和命令执行都路由进你在平台上的专属容器。

#### 安装

```bash
# 方式一：复制到 pi 全局自动发现目录（推荐，所有项目生效）
cp -R /path/to/pi-sandbox-extension ~/.pi/agent/extensions/pi-sandbox-extension

# 方式二：单项目临时加载
cd /path/to/your/project
pi -e /path/to/pi-sandbox-extension
```

无需 `npm install`——扩展零运行时依赖，用 Node 内置的 fetch。

#### 配置

扩展配置存在 `~/.pi/agent/extensions/sandbox-platform.json`。最简单的方式是登录后自动生成，也可以手动建：

```json
{
  "url": "https://sandbox.corp.com",
  "username": "your-username"
}
```

⚠️ 这个文件存你的 token、API key、LLM key 明文。扩展会自动设 `0600` 权限；多用户系统上建议确认：

```bash
chmod 700 ~/.pi/agent/extensions
chmod 600 ~/.pi/agent/extensions/sandbox-platform.json
```

**环境变量覆盖**（优先级最高，适合 CI/自动化）：

| 变量 | 用途 |
|------|------|
| `SANDBOX_PLATFORM_URL` | 平台地址 |
| `SANDBOX_PLATFORM_TOKEN` | 预先取得的 JWT（跳过登录） |
| `SANDBOX_API_KEY` | 长期 API key（`sk_...`），优先于 JWT，不会过期 |
| `SANDBOX_PLATFORM_USERNAME` | 登录提示的默认用户名 |
| `SANDBOX_CONTAINER` | 启动时自动连接的容器 ID |

#### 日常使用流程

```bash
# 1. 在项目目录启动 pi（带扩展）
pi -e /path/to/pi-sandbox-extension

# 2. 首次需登录（token 缓存 7 天，之后免登录）
/sandbox-login
# 输入用户名密码

# 3. 扩展自动连接/创建容器，然后正常用 pi
#    read/write/edit/bash/grep/find/ls 全部在容器里执行
```

连接容器时，扩展会自动把你的本地项目同步进容器的 `/workspace`（跳过 `.git`、`node_modules`、`dist` 等大目录和超过 8MB 的文件）。之后你本地和容器里的文件保持一致。

#### 斜杠命令

| 命令 | 作用 |
|------|------|
| `/sandbox-login` | 登录平台（用户名/密码） |
| `/sandbox-status` | 查看当前用户、容器、连接状态 |
| `/sandbox-list` | 列出运行中的容器并选择连接 |
| `/sandbox-new` | 新建容器并连接（选镜像、填名字） |
| `/sandbox-sync` | 重新把本地项目同步进容器 `/workspace` |
| `/sandbox-url` | 显示平台地址 |
| `/sandbox-apikey` | 管理你的长期 API key（创建/列出/吊销/粘贴使用） |
| `/sandbox-llm` | 查看/刷新 LLM 配置（见下文） |

#### 自动建容器

如果启动时没有运行中的容器，扩展会自动从第一个公共镜像建一个（用该镜像的默认资源），并连上——所以登录后就能直接写代码。想指定镜像用 `/sandbox-new`。

#### 工作区同步

容器在远端服务器，项目在你本地。`/sandbox-sync`（以及自动建容器时）会把本地项目上传到容器的 `/workspace`：

- **跳过**：`.git`、`node_modules`、`dist`、`build`、`target`、`.venv`、`venv`、`__pycache__`、`.zcode`、`.pi`
- **跳过**：超过 8MB 的文件（平台请求体上限 16MB，base64 编码后膨胀 33%）
- 本地改动后重跑 `/sandbox-sync` 刷新容器里的副本

> 注意：当前同步是**单向**的（本地 → 容器）。容器内的改动不会自动回写本地。

#### 离线兜底

没有连上容器、或平台不可达时，扩展自动回退到**本地执行**（容器路径 `/workspace/...` 会映射到本地项目目录）。所以加载扩展永远不会让 pi 无法工作——只是没连容器时工具跑在你本机。

### 用 Web 控制台

浏览器打开平台地址，登录后左侧导航可见的功能（普通用户）：

| 页面 | 作用 |
|------|------|
| **Dashboard** | 你的容器数、运行中数、24h 失败数、状态分布 |
| **Containers** | 你的容器：启动/停止/销毁、快照管理（创建/恢复/删除） |
| **Workspaces** | 持久工作区：文件浏览、上传/下载、建目录（建容器时可指定作为 `/workspace` 种子） |
| **Images** | 可用的公共镜像列表（只读） |
| **Logs** | 你自己的操作日志（只看自己的） |
| **LLM keys** | 你的 LLM 访问：花费、key 管理（见下文） |

**工作区**是平台服务器上的持久存储，容器销毁后不丢。建容器时可以选一个工作区作为 `/workspace` 的初始内容（容器重建后能恢复文件）。

**个人 API key**：点左下角用户名旁的 "My API keys"。创建后明文只显示一次（`sk_...` 格式），用于脚本/CI 调平台 API，不过期，可吊销。

### LLM（大模型）使用

平台可能开启了 LLM 集成（LiteLLM 网关）。**需要管理员先给你授权**——没授权时 LLM 相关入口会提示"未开通"。

#### 方式一：pi 扩展自动配置（推荐）

授权后，扩展在每次 `/sandbox-login` 后**自动**完成 LLM 配置：

1. 检测到你已被授权
2. 取得（或复用缓存的）virtual key
3. 注册 `amedac.ai` provider 到 pi（模型列表自动从 LiteLLM 拉取）
4. 你在 `/model` 里就能选 `amedac.ai/<模型名>` 开始用

全程**不需要手动复制 key**。每次 LLM 请求会自动带上 pi 的 session id（LiteLLM 据此按会话归组计费）。

手动控制：`/sandbox-llm` 命令查看状态（预算/已用/缓存 key）、重新注册 provider、或强制刷新（清缓存重新取 key——key 被管理员轮换后用这个）。

#### 方式二：Web 控制台拿 key

**入口**：左侧导航 → **LLM keys**

- 看当前花费 / 预算 / 重置周期
- 列出你的 virtual key（只显示前缀）
- **Reveal**：解密显示某个 key 的完整明文（用于手动配置 SDK）——这是敏感操作，有频率限制
- **Revoke**：吊销某个 key
- 显示 LLM 网关地址（base URL），配合 key 用于直连

拿到 key 后，可以这样调 LiteLLM（OpenAI 兼容）：

```bash
curl http://<litellm地址>:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

Anthropic 格式（注意用 `x-api-key` 而非 Bearer）：

```bash
curl http://<litellm地址>:4000/v1/messages \
  -H "x-api-key: sk-..." \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
```

#### 容器内使用 LLM

如果你的容器是在你被授权后创建的，平台会自动把两个环境变量注入容器：

| 环境变量 | 值 |
|----------|-----|
| `SANDBOX_LLM_BASE_URL` | LiteLLM 网关地址（带 `/v1`） |
| `SANDBOX_LLM_API_KEY` | 你的 virtual key 明文 |

容器内的进程（你的代码、其他工具）可以直接读这两个变量调 LLM。**注意**：这两个变量在容器的 GET 响应里会被 mask 成 `***`（不回显明文），但容器内进程能拿到真实值。

> 授权后才建的容器才会注入。如果先建容器后授权，重建容器（stop 后 start，或新建）即可生效。

---

## 故障排查 FAQ

### 登录相关

**Q: 登录提示 "Session expired" / 401**
A: token 过期了。pi 扩展里重跑 `/sandbox-login`；Web 控制台重新登录。如果用 API key 模式（`SANDBOX_API_KEY`），key 不会过期，检查是否被吊销。

**Q: pi 扩展提示 "Not logged in. Run /sandbox-login first"**
A: 没有缓存 token。跑 `/sandbox-login` 输入账密。如果是在 CI 里，用 `SANDBOX_API_KEY` 环境变量（先在 Web 控制台 "My API keys" 创建一个）。

**Q: Web 控制台刷新页面后要重新登录？**
A: 不会。token 存在 localStorage，刷新保持会话。如果每次都要重登，检查浏览器是否禁用了 localStorage。

### 容器相关

**Q: 工具调用提示 "container not found" / 连不上容器**
A: 容器可能已停止或被回收。跑 `/sandbox-list` 看运行中的容器，或 `/sandbox-new` 建新的。长时间空闲的容器会被 reaper 自动停止（默认 7 天），下次连接会自动恢复。

**Q: 容器里的文件和我本地不一致**
A: 本地改动后跑 `/sandbox-sync` 重新同步。注意同步是单向的（本地→容器）；容器内的改动不会回本地。

**Q: `/sandbox-sync` 提示某些文件跳过了**
A: 默认跳过大目录（`.git`/`node_modules` 等）和超过 8MB 的文件。这是设计如此，避免同步巨量依赖。大文件建议放进工作区（Web 控制台的 Workspaces 页上传）。

**Q: 创建容器失败，提示 "quota exceeded"**
A: 你的配额 tier 上限到了（容器数/CPU/磁盘）。联系管理员调高配额，或销毁不用的容器（`/sandbox-list` 没有销毁命令，用 Web 控制台的 Containers 页销毁）。

**Q: 容器里跑命令很慢**
A: 容器在远端服务器，每个工具调用都走网络。`bash` 命令支持实时流式输出（SSE），长命令能看到进度。如果服务器在远地，网络延迟是主因。

### LLM 相关

**Q: pi 扩展里 `/model` 看不到 amedac.ai / 没有模型**
A: 几种可能：
1. 你还没被管理员授权 LLM → 找管理员开通
2. LLM 集成未启用 → Web 控制台的 "LLM keys" 页会提示 "not enabled"
3. 模型列表拉取失败 → 跑 `/sandbox-llm` 看状态，必要时 "Force refresh"
4. LiteLLM 网关不可达 → 联系管理员检查 LiteLLM 服务

**Q: LLM 请求返回 "budget exceeded"**
A: 你的花费超出了管理员给的预算。预算按重置周期（如 `1d`/`30d`）自动恢复，或联系管理员调高。

**Q: LLM 请求返回 401 / "invalid key"**
A: 你的 virtual key 可能被吊销或轮换了。pi 扩展里跑 `/sandbox-llm` → "Force refresh" 重新取 key。Web 控制台在 "LLM keys" 页 revoke 旧 key 后会自动发新的。

**Q: 授权后建的容器才有 LLM 环境变量？**
A: 是。`SANDBOX_LLM_*` 环境变量在容器创建时注入。先授权后建容器 → 有；先建容器后授权 → 重建容器（stop/start 或新建）即可。

### 镜像相关

**Q: 镜像列表里没有我刚放的 SIF 文件**
A: 镜像列表来自**数据库**，不是扫描文件系统。把 SIF 文件放进服务器目录不会自动出现——必须让管理员在 Web 控制台的 Images 页新增一条记录，填好 `sif_path`（服务器上 SIF 的真实路径）。

**Q: 创建容器报错 "image not found" 或 apptainer 启动失败**
A: 镜像记录里的 `sif_path` 在服务器上不存在或路径不对。让管理员核对 Images 页的 `sif_path` 指向真实存在的 SIF 文件。

### 其他

**Q: Web 控制台显示 "Admin UI not built"**
A: 前端没构建。这通常是部署问题——告诉部署者在 `sandbox-platform/web` 跑 `npm run build`。

**Q: pi 扩展加载报错或行为异常**
A: 扩展会自动回退到本地执行（不会让 pi 崩溃）。先跑 `/sandbox-status` 看连接状态。检查 `~/.pi/agent/extensions/sandbox-platform.json` 配置是否正确。

**Q: 平台地址是多少？**
A: 问部署者/管理员。默认 `http://localhost:3000`（本地开发），生产环境是部署者配置的地址。pi 扩展里跑 `/sandbox-url` 可查看当前配置的地址。

---

## 参考

- 开发/贡献指南：[`AGENTS.md`](../AGENTS.md)
- 部署 LiteLLM 网关：[`sandbox-platform/litellm/README.md`](../sandbox-platform/litellm/README.md)
- pi 扩展完整说明：[`pi-sandbox-extension/README.md`](../pi-sandbox-extension/README.md)
- 架构图：[`项目架构图.md`](项目架构图.md)
- 改进追踪：[`IMPROVEMENTS.md`](IMPROVEMENTS.md)
