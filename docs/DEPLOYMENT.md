# 部署指南（R3：反向代理 / systemd / pi-web 拓扑 / 健康探针）

> 适用版本：pi-web 集成升级后的 sandbox-platform。目标：在一台干净的 Linux
> 主机上完成带 HTTPS 的部署，pi-web 登录与沙箱工具链路（REST + SSE +
> WebSocket）全通。

## 0. 前置条件

| 组件 | 要求 |
|---|---|
| Node.js | ≥ 20.11（后端用 `--experimental-transform-types` 直跑 TS） |
| 数据库 | sqlite（默认，零依赖）或 PostgreSQL 15+ |
| 容器运行时 | Apptainer ≥ 1.3（仅生产执行器需要；`EXECUTOR_KIND=mock` 可无容器运行） |
| TLS 证书 | 由 Nginx/Caddy 或云 LB 终结；平台本身只听 HTTP |

## 1. 反向代理

平台有三个长连接通道，代理配置必须同时照顾：

1. **SSE**（`POST /api/v1/containers/:id/tools/bash/stream`）：`text/event-stream`，禁止缓冲。
2. **WebSocket**（`GET /api/v1/containers/:id/pty`）：需要 Upgrade 头透传。
3. **大文件上传**（`PUT /api/v1/workspaces/:id/uploads/:uid`）：单请求体可达 `WORKSPACE_UPLOAD_MAX_BYTES`。

### 1.1 Nginx

```nginx
# /etc/nginx/site-availables/sandbox.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name sandbox.example.edu;

    ssl_certificate     /etc/letsencrypt/live/sandbox.example.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sandbox.example.edu/privkey.pem;

    # 上传上限必须 >= WORKSPACE_UPLOAD_MAX_BYTES
    client_max_body_size 220m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # --- WebSocket 升级（PTY）---
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # --- SSE：关闭缓冲，拉长读超时 ---
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';   # SSE 请求不需要 upgrade，保持 keep-alive
        proxy_read_timeout 3600s;         # PTY/长命令都要 >1h
        proxy_send_timeout 3600s;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80;
    server_name sandbox.example.edu;
    return 301 https://$host$request_uri;
}
```

注意：上面把 `Connection` 同时用于 upgrade 与 keep-alive 的写法在 Nginx 中由
`map` 处理（带 `Upgrade` 头时为 `upgrade`，否则按 `$connection_upgrade` 关闭重
用）。若 SSE 出现 60s 断连，检查是否有中间层（CDN/LB）强制 `buffering on`。

### 1.2 Caddy

```caddyfile
sandbox.example.edu {
    reverse_proxy 127.0.0.1:3000 {
        # WebSocket 与 SSE 都是长连接；Caddy 默认不缓冲，无需额外配置。
        transport http {
            read_timeout 3600s
            write_timeout 3600s
        }
    }
    # 大文件上传：Caddy 默认无请求体上限，与平台侧 WORKSPACE_UPLOAD_MAX_BYTES 对齐即可。
}
```

### 1.3 可选路径前缀（`/sandbox/`）

平台本身不感知前缀；需要挂在子路径时：

1. Nginx：`location /sandbox/ { proxy_pass http://127.0.0.1:3000/; ... }`（尾斜杠剥掉前缀）。
2. Web 管理台是 SPA，需同步构建：`web/vite.config.ts` 设 `base: "/sandbox/"` 后重新 `npm run build`。
3. pi 扩展 / pi-web 的 `SANDBOX_PLATFORM_URL` 直接写 `https://host/sandbox`。

## 2. systemd 服务

```ini
# /etc/systemd/system/sandbox-platform.service
[Unit]
Description=Sandbox Platform (Apptainer management)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=sandbox
Group=sandbox
WorkingDirectory=/opt/sandbox-platform
Environment=NODE_ENV=production
EnvironmentFile=/opt/sandbox-platform/.env
ExecStart=/usr/bin/node --experimental-transform-types --no-warnings=ExperimentalWarning src/index.ts
Restart=always
RestartSec=5

# 硬化
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/sandbox-platform/data /opt/sandbox-platform/backups
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sandbox-platform
```

## 3. `EXECUTOR_KIND=ssh` 生产参数清单

推荐拓扑：平台进程跑在管理节点，SSH 到 Apptainer 计算节点（rootless）。

| 项 | 要求 / 建议 |
|---|---|
| Apptainer 安装 | **rootless**（官方脚本 `install-unprivileged.sh` 装到 `~/.local`），版本 ≥ 1.3 |
| SSH 账号 | 专用低权限账号（如 `sandbox-run`），禁用 shell 登录仅允许 sftp/exec 可省略——执行器只用 exec/putDirectory |
| 密钥文件 | `SSH_PRIVATE_KEY_PATH` 指向平台侧私钥；`chmod 600`；建议 ed25519；放在 `ProtectSystem=strict` 可读路径（如 `/etc/sandbox/`，加 `ReadOnlyPaths=`） |
| 远端目录 | `/srv/apptainer/overlays`、`/srv/apptainer/workspace-seeds` 需对 SSH 账号可写：`install -d -o sandbox-run /srv/apptainer/{overlays,workspace-seeds}` |
| 镜像目录 | `IMAGE_BASE_DIR` 若与远端 `sif_path` 不一致，以 DB 中登记的远端路径为准（SSH 执行器在远端解析） |
| cgroups | 需要 `--cpus/--memory` 限额时设 `APPTAINER_RESOURCE_LIMITS=true`，要求 cgroups v2（rootless + v1 会报 "rootless cgroups requires cgroups v2"） |
| 资源上限 | 每用户走配额（`resource_quotas`），配额白名单（`allowed_image_ids`）限定可选镜像 |
| LLM | 可选组件，见 README "LiteLLM（可选）"；`LLM_ENABLED=false`（默认）时整组 `/api/v1/*llm*` 返回 501，容器不注入任何 `SANDBOX_LLM_*` |

## 4. 与 pi-web 的两种拓扑

### A. 同机反代（小规模 / 单机教学）

```
用户浏览器 ──HTTPS──► Nginx/Caddy (:443)
                       ├─ /            → pi-web (Next.js, :3001)
                       └─ /api,/health → sandbox-platform (:3000)
pi-web 服务端/浏览器 ──同源 /api──► 平台（登录 + REST）
浏览器 xterm ──WS /api/v1/containers/:id/pty──► 平台（容器终端）
```

Nginx 追加：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;   # pi-web
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
location ^~ /api/ {
    proxy_pass http://127.0.0.1:3000;   # 平台（含 /api/v1/.../pty WebSocket）
    # …同第 1.1 节的 upgrade/缓冲配置…
}
```

### B. 分机部署（平台独立扩缩）

```
浏览器 ──HTTPS──► pi-web 节点 (:443)          平台节点 (:3000, 仅内网/独立TLS)
pi-web ──HTTPS SANDBOX_PLATFORM_URL──► 平台
浏览器 ──WSS──── 直连平台公网地址（PTY WebSocket 的 token 走 ?token= 查询参数）
```

要点：
- 平台侧需独立 TLS（或走内网）；跨域时给平台加 `TRUST_PROXY=1` 并在 pi-web
  侧携带凭证。
- PTY WebSocket 的认证是 `?token=<JWT>`（浏览器无法在 WS 握手设置 header），
  因此**代理层不要把 query string 记入 access log**（Nginx：`log_format` 里用
  `$uri` 代替 `$request_uri`）。

### 端口矩阵

| 端口 | 服务 | 暴露范围 |
|---|---|---|
| 443 | 反代（Nginx/Caddy） | 公网 |
| 3000 | sandbox-platform | 反代后端（或内网） |
| 3001 | pi-web (Next.js) | 反代后端 |
| 4000 | LiteLLM proxy（**可选**） | 仅客户端直连需要；默认关闭 |
| 5432/5433 | 平台 PG / LiteLLM PG | 仅 localhost |

## 5. 健康探针与监控接入

| 端点 | 语义 | 建议用法 |
|---|---|---|
| `GET /health` | 进程存活（不含依赖） | K8s liveness / uptime 监控 |
| `GET /ready` | DB 可达 + overlay 目录可写 +（启用时）LiteLLM 可达 | K8s readiness / 反代摘除 |
| `GET /metrics` | Prometheus 指标（`METRICS_TOKEN` 时需 Bearer） | Prometheus scrape 30s |

非容器部署的 watch 建议（systemd + cron 或外部探针）：

```bash
# 每 30s 探活，连续失败告警
*/1 * * * * curl -fsS -m 5 http://127.0.0.1:3000/ready || systemctl restart sandbox-platform
```

`/ready` 返回 503 即视为不健康；原因看 `journalctl -u sandbox-platform`。

## 6. 升级 / 回滚

```bash
cd /opt/sandbox-platform
sudo -u sandbox git pull            # 或解包新版本
sudo -u sandbox npm ci --ignore-scripts
sudo -u sandbox npm run migrate     # 启动时也会自动 migrate
sudo systemctl restart sandbox-platform
```

回滚：`git checkout <prev> && npm ci && npm run migrate:rollback && systemctl restart`。
数据库改动的迁移都带 `down`（见 `src/db/migrations/`）。
