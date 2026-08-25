# Apptainer 轻量用户手册（中文版）

> 面向 AgentSandbox 平台用户与运维的极简参考手册。
> 聚焦三类高频场景：**持久化覆盖层（Persistent Overlay）**、**实例生命周期（Instance Lifecycle）**、**快照与备份恢复（Snapshot & Backup）**。
> 完整文档见 <https://apptainer.org/docs/user/main/>。

---

## 0. 速查表

| 你想做的事 | 用什么 |
|---|---|
| 让容器可写且**重启后保留**修改 | 持久化覆盖层 `--overlay` |
| 临时可写、停止即丢 | `--writable-tmpfs` |
| 后台运行一个容器 | `apptainer instance start` |
| 查看后台实例 | `apptainer instance list` |
| 进入运行中的实例执行命令 | `apptainer instance exec <name> <cmd>` |
| 停止实例 | `apptainer instance stop <name>` |
| 备份覆盖层（一致性快照） | **先 stop → 再 cp/tar → 最后 restart** |
| 给容器加磁盘配额 | 创建 ext3 overlay 时指定 `--size` |

---

## 1. 三分钟概念图

```
┌─────────────────────────────────────────────────────────┐
│  容器内看到的文件系统（OverlayFS 合并视图）              │
│                                                          │
│   ┌─────────────────────────── 上层（upper / 可写）────┐│
│   │  Persistent Overlay（目录 或 ext3 镜像）           ││  ← 你的修改写到这里
│   │  apptainer instance start --overlay overlay.img    ││
│   └────────────────────────────────────────────────────┘│
│   ┌─────────────────────────── 下层（lower / 只读）────┐│
│   │  SIF 镜像（squashfs，不可变）                       ││  ← 系统软件栈
│   └────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

- **SIF（squashfs）**：只读基础镜像，类似 Docker 的 image layer。
- **Overlay**：可写层。所有"在容器里安装 pip 包、改配置、写文件"的动作，都落到这里。Overlay 与 SIF **分离**，所以可以换 base image 而保留改动（需要兼容）。
- **Instance**：后台常驻进程。一个 SIF + 一个 overlay = 一个实例。

> ⚠️ **关键约束**：**同一个 ext3 overlay 不能被多个实例同时挂载为可写**（Apptainer < 1.4 不对 ext3 overlay 加文件锁，见 [apptainer#839](https://github.com/apptainer/apptainer/issues/839)）。同时挂载会**损坏数据**。AgentSandbox 在 `instance start` 前已强制校验 overlay 未被占用，但手工操作时务必注意。

---

## 2. 持久化覆盖层（Persistent Overlay）

### 2.1 两种形态对比

| | ext3 镜像文件 | 目录 overlay |
|---|---|---|
| 创建 | `apptainer overlay create` | `mkdir` |
| 跨网络文件系统 | ✅ 稳定 | ❌ 在 NFS/Lustre/GPFS 上**不可靠** |
| 容量上限 | ✅ 创建时固定（可 resize） | ❌ 无上限，受宿主目录配额约束 |
| setuid 模式下普通用户 | ✅ 可直接用 | ❌ 需 `--fakeroot`/`--userns` |
| 备份 | 单文件 cp/tar 即可 | 需递归拷贝整个目录 |
| **推荐场景** | **生产环境、AgentSandbox** | 仅本地快速测试 |

> AgentSandbox 生产用 **ext3 镜像**；当前后端的 SshExecutor 暂用**目录 overlay**（简化实现），未来规划迁移到 ext3 + 配额。

### 2.2 创建 ext3 overlay

```bash
# 1. 创建一个 1 GiB 的 overlay 镜像（需 dd + 支持 -d 的 mkfs.ext3）
apptainer overlay create --size 1024 /srv/overlays/my.overlay.img

# 2. 稀疏文件：按需占用磁盘（推荐，节省空间）
apptainer overlay create --sparse --size 10240 /srv/overlays/big.overlay.img

# 3. 创建时预置可写目录（fakeroot 场景常用）
apptainer overlay create --size 2048 --create-dir /workspace --create-dir /home/user /srv/overlays/ws.overlay.img

# 4. 给非 root 容器（fakeroot）使用的 overlay
apptainer overlay create --fakeroot --size 1024 /srv/overlays/fr.overlay.img
```

**容量即配额**：`--size` 一旦创建就是该 overlay 的**硬上限**。用户在容器里 `df -h /` 会看到这个大小。这是 AgentSandbox 落实磁盘配额（diskGb）的底层机制。

### 2.3 调整 ext3 overlay 容量

```bash
# 先停止所有使用该 overlay 的实例（必须！）
apptainer instance stop myinstance

# 检查 → 扩容/缩容（标准 Linux 工具）
e2fsck -f /srv/overlays/my.overlay.img
resize2fs /srv/overlays/my.overlay.img 2048M   # 扩到 2 GiB

# 重新启动实例（instance start ... --overlay /srv/overlays/my.overlay.img）
```

> 缩容有数据丢失风险，建议只扩不缩。

### 2.4 运行时使用 overlay

```bash
# shell 进交互（可写）
apptainer shell --overlay /srv/overlays/my.overlay.img ubuntu.sif

# exec 跑一条命令
apptainer exec --overlay /srv/overlays/my.overlay.img ubuntu.sif pip install pandas

# 启动后台实例（AgentSandbox 主用法）
apptainer instance start \
  --overlay /srv/overlays/my.overlay.img \
  ubuntu.sif myinstance

# 只读挂载一个已完成的 overlay（演示/审查/复用快照）
apptainer shell --overlay /srv/overlays/my.overlay.img:ro ubuntu.sif
```

`:ro` 后缀 = 只读层，不会写入；可同时被多个实例挂载（读多写少场景的快照复用）。

### 2.5 把 overlay 嵌入 SIF（单文件分发）

```bash
# 直接给 SIF 加一层 overlay 分区（注意：SIF 不能是已签名/已加密/已有 overlay 的）
apptainer overlay create --size 1024 ubuntu.sif

# 之后用 --writable 才能写内嵌 overlay（需 --fakeroot 或 root）
apptainer shell --writable --fakeroot ubuntu.sif
```

适合"一份镜像 + 一份改动"打包分发；**不适合多实例**（一个 SIF 同时只能一个可写挂载）。AgentSandbox **不采用**此模式。

---

## 3. 实例生命周期（Instance Lifecycle）

### 3.1 完整生命周期

```
        instance start           instance exec / shell            instance stop
[镜像] ──────────────► [运行中] ──────────────────────► [运行中] ──────────────► [已停止]
                          │                                                      │
                          └────  instance list / instance stats  ────────────────┘
                          │                                                      │
                          └────  overlay 文件始终保留（除非手动 rm） ────────────┘
                                                                                  │
                                                          instance start ◄────────┘
                                                          （用同一 overlay，状态延续）
```

**核心原则**：overlay 是**持久**的，instance 是**临时**的。停实例 = 停进程，**不删数据**。删 overlay 文件才会丢数据。

### 3.2 启动实例 `instance start`

```bash
apptainer instance start [选项] <容器镜像> <实例名> [启动脚本参数...]
```

**AgentSandbox 生产启动模板**（含资源限制、隔离、workspace 挂载）：

```bash
apptainer instance start \
  --overlay /srv/overlays/<instance-id>.overlay.img \
  --bind /srv/workspaces/<user>:/workspace \
  --bind /srv/data/shared:/srv/shared:ro \
  --contain \
  --workdir /srv/apptainer/run/<instance-id> \
  --home /srv/workspaces/<user>:/home/<user> \
  --cpus 2 \
  --memory 4096M \
  --no-mount hostfs,cwd \
  --fakeroot \
  /srv/images/python-3.11.sif \
  sbx-<instance-id>
```

**关键 flag 速览**（生产最常用）：

| flag | 作用 | 示例 |
|---|---|---|
| `--overlay PATH[:ro]` | 挂载持久 overlay | `--overlay /srv/ov/a.img` |
| `--bind src[:dst][:opts]` | 绑定宿主目录到容器 | `--bind /data:/mnt:ro` |
| `--mount type=bind,src=...,dst=...[,ro]` | OCI 风格 mount（推荐，支持逗号路径） | 见下 |
| `--contain` | 不自动挂 `$HOME`/`/tmp` 等，强制隔离 | 单独用 |
| `--containall` | `--contain` + PID/IPC/env 隔离 | 更强隔离 |
| `--workdir DIR` | 容器内 `/tmp`、`/var/tmp`、`$HOME`（配 `--contain`）的宿主落点 | `--workdir /srv/run/x` |
| `--home src[:dst]` | 自定义 `$HOME` 映射 | `--home /srv/u/alice:/home/alice` |
| `--cpus N` | CPU 核数上限 | `--cpus 2` |
| `--memory N` | 内存上限（字节或带单位） | `--memory 4096M` |
| `--memory-swap N` | swap 上限，`-1` 无限 | `--memory-swap 8G` |
| `--pids-limit N` | 进程数上限，`-1` 无限 | `--pids-limit 512` |
| `--no-mount home,cwd,tmp,...` | 关闭特定系统挂载 | `--no-mount hostfs` |
| `--no-home` | 不挂宿主 `$HOME`（= `--no-mount home`） | 单独用 |
| `--fakeroot` | 容器内以 root 身份运行（实际无宿主权限） | 推荐配合 overlay |
| `--userns` | 用 unprivileged user namespace（rootless 模式） | 推荐生产 |
| `--writable-tmpfs` | 临时可写（内存，停止即丢，默认上限 64 MiB） | 临时实验 |

### 3.3 操作运行中实例

```bash
# 列出当前用户的所有实例
apptainer instance list
# INSTANCE NAME    PID        IMAGE                                  PATH
# myinstance       12345      /srv/images/ubuntu.sif                 /srv/images

# 进入实例执行命令（AgentSandbox bash 工具的底层）
apptainer instance exec myinstance bash -c 'df -h / && whoami'

# 交互式 shell
apptainer shell instance://myinstance

# 查看资源占用
apptainer instance stats myinstance

# 停止实例（优雅停止，等进程退出）
apptainer instance stop myinstance
# 强制杀（5 秒后未退）
apptainer instance stop --force myinstance
# 停止所有自己的实例
apptainer instance stop --all
```

> `instance exec` / `shell instance://name` 进入的是**同一个** mount namespace 和 overlay——你在 shell 里装的包，`instance exec` 跑的程序也能看到。

---

## 4. 快照与备份恢复

> 这是 AgentSandbox "基于覆盖层复制的伪快照"策略的底层原理。Apptainer 自身没有"快照"命令，所谓快照 = **在 overlay 处于静止状态时拷贝 overlay 文件**。

### 4.1 一致性铁律：Stop-Then-Copy

**做任何快照前，必须先停实例。** 原因：

1. ext3 overlay 不加文件锁，运行中拷贝 = 拷到一半被写 = **不一致**。
2. 内核可能还在刷脏页到 overlay，`cp` 看到的是中间态。
3. 数据库类负载尤其敏感（半写事务 = 启动后 fsck 失败）。

**正确流程**：

```bash
# 1. 停实例（overlay 文件保留在磁盘上）
apptainer instance stop myinstance

# 2. 拷贝 overlay 即"快照"
cp /srv/overlays/my.overlay.img /srv/snapshots/snap-$(date +%Y%m%d-%H%M).overlay.img

# 3. 重启实例（用原 overlay，状态延续）
apptainer instance start --overlay /srv/overlays/my.overlay.img ubuntu.sif myinstance
```

> AgentSandbox 的 `POST /containers/:id/snapshots` 已实现"先 stop → cp overlay → restart"流程（见 `container.service.ts:266-272` 的 restoreSnapshot 同款思路）。**手工运维也务必遵循。**

### 4.2 三种快照载体选择

| 方法 | 命令 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| **裸拷贝** | `cp a.img snap.img` | 最快、无依赖 | 占满全量空间 | 默认 |
| **tar 归档** | `tar -cSf snap.tar a.img` | 可压缩、可加密 | 解压需时 | 跨机备份 |
| **稀疏 + tar** | `tar --sparse -cSf snap.tar a.img` | 省空间（`--sparse` 保留空洞） | 需 `--sparse` 还原 | 稀疏 overlay |
| **rsync 增量** | `rsync -a --inplace a.img snap.img` | 仅传差异 | 第一次仍全量 | 远端备份 |

**稀疏 overlay 的备份/恢复**（AgentSandbox 推荐用 `--sparse` 创建）：

```bash
# 备份（保留稀疏空洞）
tar --sparse -cSf /backups/snap-2026-08-07.tar /srv/overlays/12.overlay.img
rsync -aS /srv/overlays/12.overlay.img /backups/12.overlay.img

# 还原（恢复稀疏）
tar --sparse -xSf /backups/snap-2026-08-07.tar
cp --sparse=always /backups/12.overlay.img /srv/overlays/12.overlay.img
```

⚠️ 普通 `cp` 会把稀疏空洞填满为真实 0 字节，**容量爆炸**。务必带 `--sparse=always`。

### 4.3 从快照恢复实例

```bash
# 场景：实例损坏 / 误删文件，想回到昨天状态
apptainer instance stop myinstance          # 停当前实例

cp /srv/snapshots/snap-20260806.overlay.img \
   /srv/overlays/my.overlay.img             # 用快照覆盖当前 overlay

apptainer instance start \
  --overlay /srv/overlays/my.overlay.img \
  ubuntu.sif myinstance                      # 启动，状态 = 快照那一刻
```

> **保留原 overlay 再覆盖**是个好习惯：`mv my.overlay.img my-broken.overlay.img` 再 cp，方便回滚。

### 4.4 压缩与异地备份

```bash
# 压缩归档（gzip，节省 ~50-70%，overlay 内多为可压缩二进制）
tar -cSf - /srv/overlays/12.overlay.img | gzip -6 > /backups/12-$(date +%F).tar.gz

# zstd 更快（建议生产）
tar -cSf - /srv/overlays/12.overlay.img | zstd -3 > /backups/12-$(date +%F).tar.zst

# 增量异地备份（结合 rsync，仅传变化块）
rsync -aS --partial /srv/overlays/12.overlay.img user@backup:/backups/12.overlay.img
```

### 4.5 保留策略（GFS：祖父-父亲-儿子）

AgentSandbox 默认建议：

| 周期 | 保留份数 | 存储位置 |
|---|---|---|
| 每日 | 7 | 本机 `/srv/snapshots/daily/` |
| 每周 | 4 | 本机或 NAS `/srv/snapshots/weekly/` |
| 每月 | 6 | 异地 `/backups/monthly/` |

cron 模板（每日凌晨 3 点 + 清理）：

```bash
# /etc/cron.d/apptainer-snapshot
0 3 * * *  apps  /usr/local/bin/apptainer-snap-all daily 7
0 4 * * 0  apps  /usr/local/bin/apptainer-snap-all weekly 4
0 5 1 * *  apps  /usr/local/bin/apptainer-snap-all monthly 6
```

`apptainer-snap-all` 脚本骨架：

```bash
#!/usr/bin/env bash
# 用法: apptainer-snap-all <tier> <keep>
set -euo pipefail
TIER="$1"; KEEP="$2"
DIR="/srv/snapshots/${TIER}"
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M)

# 对每个 overlay 做一次"停-拷-启"快照（伪代码，实际按 instance 名映射）
for img in /srv/overlays/*.overlay.img; do
  name=$(basename "$img" .overlay.img)
  inst=$(instance-name-for "$name")          # 你的 instance 名映射
  apptainer instance stop "$inst" 2>/dev/null || true
  tar --sparse -cSf "${DIR}/${name}-${STAMP}.tar" "$img"
  apptainer instance start --overlay "$img" /srv/images/base.sif "$inst"
done

# 清理超额（保留最近 KEEP 份 per overlay）
find "$DIR" -name '*.tar' -mtime +${KEEP} -delete
```

---

## 5. AgentSandbox 自动化策略（已实现）

平台层基于第 2–4 节的底层能力，落地了以下自动化。配置项见 `sandbox-platform/.env.example` 的 `Reaper` 段。

### 5.1 长时间无操作自动备份并释放 ✓

默认一周（168 小时）未连接的容器，后台 reaper 自动 **Stop-Then-Copy 快照 → 停止实例 → 释放资源**，再次连接时按需恢复。实现见 `src/scheduler/reaper.ts`。

```
后台 reaper（每 REAPER_INTERVAL_MINUTES 扫描）：
  for each container where status='running':
    idle = now() - max(last_session_end, last_started_at)
    if idle > IDLE_AUTO_STOP_HOURS (默认 168h=7d):
      1. executor.stop(handle)                     # quiesce 实例
      2. 若 IDLE_AUTO_STOP_SNAPSHOT=true：          # Stop-Then-Copy 快照
           snapshot(auto-<tier>-<ts>)
      3. 容器标记 stopped；下次 connect/start 自动恢复
```

**配置项**（`.env`）：

```ini
REAPER_ENABLED=false                # 生产建议 true
REAPER_INTERVAL_MINUTES=30
IDLE_AUTO_STOP_HOURS=168            # 默认一周
IDLE_AUTO_STOP_SNAPSHOT=true        # 释放前自动快照（强烈建议 true）
IDLE_AUTO_STOP_SNAPSHOT_TIER=auto   # 快照命名前缀
AUDIT_RETENTION_DAYS=90             # 审计日志软删保留期（0=不清理）
```

> 注：审计日志采用**软删**（`operation_logs.purged_at`），不破坏 SHA-256 哈希链的完整性，详见迁移 `0009_audit_soft_purge`。

### 5.2 配额与磁盘 ✓

- **物理容量限制**：每个 overlay 创建时用 `apptainer overlay create --size <diskGb*1024>` 物理限定容量（`apptainer-cli-executor.ts` 的 `ensureOverlay`），失败则 fallback 到无上限的目录 overlay。
- **用户级聚合磁盘配额**：`quota.service.ts` 的 `assertAggregateDisk` 校验 `sum(overlays.size) + sum(snapshots.size)` 不超过 quota tier 的 `max_disk_gb`，快照创建时触发。
- **快照数配额**：`max_snapshots_per_container` 在创建快照时拦截。
- **容器/工作区数配额**：`max_containers` / `max_workspaces_per_user` 在创建时拦截。

### 5.3 尚未实现的增强（可选）

以下为运维增强建议，当前未实现，非 MVP 阻塞项：

- **双层时间策略**：stop-on-stop 自动快照、idle 分级提醒（邮件/IM）、日/月度定时归档。当前 reaper 只做"超时释放"单一触发。
- **GFS 保留策略**：快照按 祖父-父亲-儿子 轮转（`SNAPSHOT_RETENTION_DAILY/WEEKLY`）。当前依赖用户手动 DELETE 旧快照或通过 reaper 的审计清理间接管理。
- **workspace 回写**：容器 destroy 后把 `/workspace` 的变更回写到持久化 workspace（`source_container_id` 列已预留，Phase 2）。

---

## 6. 常见问题

**Q：我可以让两个容器共用同一个 overlay 吗？**
A：**不能（可写挂载）**。Apptainer < 1.4 对 ext3 overlay 不加文件锁，并发可写会损坏数据。需要共享请用：① 只读 `:ro` 挂载（多个消费者）；② bind mount 同一宿主目录（仍要小心并发写入）。

**Q：overlay 满了怎么办？**
A：`instance stop` → `e2fsck -f` → `resize2fs img 8G` → `instance start`。或删除大文件后用 `fstrim`（需 overlay 支持 TRIM）。

**Q：`--writable` 和 `--overlay` 区别？**
A：`--writable` 直接改 SIF（需 `--fakeroot`，**改的是镜像本身**，影响所有用此 SIF 的实例）；`--overlay` 写到独立 overlay 文件（**推荐**，与 SIF 解耦）。

**Q：怎么从容器里把文件拿出来？**
A：① bind mount 宿主目录写入；② `apptainer instance exec x cp /path /host-mount`；③ stop 后 `mount -o loop overlay.img /mnt && cp`（root）。

**Q：实例 OOM 被杀，overlay 会坏吗？**
A：不会。Overlay 是宿主上的普通文件，实例进程崩溃不影响 overlay 完整性。重启即可。但若 overlay 写到一半掉电/硬件故障，ext3 可能需 `e2fsck` 修复。

**Q：NFS 上能放 overlay 吗？**
A：ext3 镜像文件可以（Apptainer 文档明确支持）；**目录 overlay 不行**（NFS 不支持 overlayfs 所需的 whiteout/opaque 语义）。

**Q：AgentSandbox 现在用 ext3 还是目录 overlay？**
A：当前 `SshExecutor`（`ssh-executor.ts:78-79`）用目录 overlay 求简化，**未强制 diskGb 上限**。生产部署建议切到 ext3 + `--size`，详见第 5.3 节。

---

## 7. 参考资料

- [Apptainer User Guide — Persistent Overlays](https://apptainer.org/docs/user/main/persistent_overlays.html)
- [Apptainer User Guide — Bind Paths and Mounts](https://apptainer.org/docs/user/1.3/bind_paths_and_mounts.html)
- [`apptainer instance start` CLI Reference](https://apptainer.org/user-docs/master/cli/apptainer_instance_start.html)
- [`apptainer-instance-start(1)` Man Page (Arch)](https://man.archlinux.org/man/apptainer-instance-start.1.en)
- [OverlayFS Kernel Docs](https://docs.kernel.org/filesystems/overlayfs.html)
- [GitHub Issue #839: ext3 overlay not locked across instances](https://github.com/apptainer/apptainer/issues/839)
- [HSF Training: Introduction to Apptainer/Singularity](https://hsf-training.github.io/hsf-training-singularity-webpage/aio/index.html)
- [Pawsey SC19: Writable Containers Tutorial](https://pawseysc.github.io/sc19-containers/04-writable-containers/index.html)
