#!/usr/bin/env bash
#
# apptainer-smoke.sh — Linux 验证脚本
#
# 逐条执行平台两个生产执行器（ssh-executor.ts / apptainer-cli-executor.ts）
# 将要运行的原始 Apptainer 命令，用于在部署前确认 overlay / instance /
# 文件操作 / 持久化 / 快照 都能真正跑通，而不是等平台上线后才发现
# 命令在目标机器上跑不起来。
#
# 用法:
#   bash scripts/apptainer-smoke.sh [--cli] [--skip-cleanup]
#     --cli           按 ApptainerCliExecutor 的命令变体测试（instance start
#                     不带 --contain --no-mount hostfs,cwd 隔离参数）
#     --skip-cleanup  结束后保留实例/overlay/快照，便于人工检查
#
# 要求:
#   - Linux 主机，已安装 apptainer（apt install apptainer 或官方脚本）
#   - 有可用的 SIF 镜像（无则脚本自动 apptainer pull alpine）
#   - rootless 环境需 fakeroot 可用 —— 见第 3 步 WRITE 检查说明
#
# 每个检查打印 PASS/FAIL；FAIL 时附带命令输出前几行；全部跑完输出汇总，
# 有 FAIL 时以退出码 1 结束。

set -u

# ---------------------------------------------------------------------------
# 可调参数（与平台 .env 的语义对应）
# ---------------------------------------------------------------------------
INSTANCE="${SMOKE_INSTANCE:-smoke01}"          # 对应容器 id
DISK_GB="${SMOKE_DISK_GB:-5}"                  # 对应容器的 diskGb
OVERLAY_DIR="${SMOKE_OVERLAY_DIR:-/srv/apptainer/overlays}"
SEED_DIR="${SMOKE_SEED_DIR:-/srv/apptainer/workspace-seeds/${INSTANCE}}"
IMAGE="${SMOKE_IMAGE:-/srv/apptainer/images/alpine_3.20.sif}"
# 资源限额（--cpus/--memory）依赖 cgroup：rootless + 宿主 cgroup v1 时
# instance start 直接失败（"rootless cgroups requires cgroups v2"）。
# 默认不传（与平台 APPTAINER_RESOURCE_LIMITS=false 一致）；在 setuid 安装
# 或 cgroups v2 宿主上用环境变量开启: SMOKE_CPUS=2 SMOKE_MEMORY=2048
SMOKE_CPUS="${SMOKE_CPUS:-}"
SMOKE_MEMORY="${SMOKE_MEMORY:-}"

OVERLAY="${OVERLAY_DIR}/${INSTANCE}.ext3"
SNAP="${OVERLAY}.snap-smoke"

# 生产执行器变体:
#   ssh:           --contain --no-mount hostfs,cwd
#   apptainer-cli: 无隔离参数（同机部署）
ISOLATION=("--contain" "--no-mount" "hostfs,cwd")
for arg in "$@"; do
  case "$arg" in
    --cli) ISOLATION=() ;;
    --skip-cleanup) SKIP_CLEANUP=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# bash -c 子 shell 不继承数组，把启动参数拼成字符串再 export。
ISOLATION_STR="${ISOLATION[*]:-}"
LIMIT_STR=""
if [ -n "$SMOKE_CPUS" ]; then LIMIT_STR+=" --cpus $SMOKE_CPUS"; fi
if [ -n "$SMOKE_MEMORY" ]; then LIMIT_STR+=" --memory ${SMOKE_MEMORY}M"; fi
START_BASE="apptainer instance start${ISOLATION_STR:+ $ISOLATION_STR}${LIMIT_STR}"

# 供 bash -c 命令串引用
export INSTANCE DISK_GB OVERLAY_DIR OVERLAY SNAP IMAGE SEED_DIR START_BASE

PASS=0
FAIL=0
FAILED=()

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

# check <描述> <bash 命令串>  —— 退出码 0 即 PASS
check() {
  local desc="$1" cmd="$2"
  if bash -c "$cmd" >/tmp/asmoke.out 2>&1; then
    PASS=$((PASS + 1)); printf '  \033[1;32mPASS\033[0m  %s\n' "$desc"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$desc")
    printf '  \033[1;31mFAIL\033[0m  %s\n' "$desc"
    sed 's/^/        /' /tmp/asmoke.out | head -5
  fi
}

# check_fails <描述> <bash 命令串> —— 期望退出码非 0
check_fails() {
  local desc="$1" cmd="$2"
  if bash -c "$cmd" >/tmp/asmoke.out 2>&1; then
    FAIL=$((FAIL + 1)); FAILED+=("$desc")
    printf '  \033[1;31mFAIL\033[0m  %s（命令意外成功）\n' "$desc"
  else
    PASS=$((PASS + 1)); printf '  \033[1;32mPASS\033[0m  %s\n' "$desc"
  fi
}

# show <描述> <bash 命令串> —— 执行一次，展示输出；退出码非 0 记 FAIL
show() {
  local desc="$1" cmd="$2" out rc
  out=$(bash -c "$cmd" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
    printf '  \033[1;32mPASS\033[0m  %s\n' "$desc"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$desc")
    printf '  \033[1;31mFAIL\033[0m  %s\n' "$desc"
  fi
  printf '%s\n' "$out" | sed 's/^/        /' | head -5
}

# ---------------------------------------------------------------------------
echo "== 环境: instance=$INSTANCE overlay=$OVERLAY image=$IMAGE =="

# 0. 前置清理（上次残留会挡住 instance start）
step "0. 前置清理 + 版本"
check "清理残留实例/overlay" 'apptainer instance stop "$INSTANCE" 2>/dev/null || true; rm -rf "$OVERLAY" "$SNAP" "$SEED_DIR"'
check "apptainer --version" 'apptainer --version'
# Preflight: rootless/fakeroot 启动 instance 依赖 cgroups v2（Rocky/RHEL8 默认 v1，
# 直接报 "rootless cgroups requires cgroups v2"）。
if [ "$(id -u)" != "0" ] && [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
  echo "  ⚠️  宿主 cgroups 为 v1 且当前非 root：rootless/fakeroot 启动 instance 会失败"
  echo "     修复 1（推荐）: sudo grubby --update-kernel=ALL --args=\"systemd.unified_cgroup_hierarchy=1\" && reboot"
  echo "     修复 2: 管理员启用 apptainer setuid（apptainer config global --set \"allow setuid\" yes）"
  echo "     修复 3: 以 root 运行本脚本（不推荐用于生产）"
fi
if [ ! -f "$IMAGE" ]; then
  echo "  (未找到 $IMAGE，自动 pull alpine:3.20)"
  check "apptainer pull alpine:3.20" 'apptainer pull docker://alpine:3.20 "$IMAGE"'
fi

# 1. overlay 创建（SshExecutor.ensureOverlay：ext3 失败自动回退目录式）
step "1. overlay 创建（稀疏 ext3，--size <diskGb*1024> MiB；失败回退目录 overlay）"
if apptainer overlay create --size $((DISK_GB * 1024)) "$OVERLAY" >/tmp/asmoke.out 2>&1; then
  PASS=$((PASS + 1)); printf '  \033[1;32mPASS\033[0m  %s\n' "overlay create（ext3 稀疏文件）"
  # 稀疏性验证：du -sB1 = 实际占用字节（-b/--apparent-size 才是表观大小，
  # 拿表观比表观永远不成立）；稀疏 ext3 实际占用应远小于表观 5G。
  check "稀疏文件：du 实际占用远小于 表观大小" 'apparent=$(stat -c %s "$OVERLAY"); real=$(du -sB1 "$OVERLAY" | cut -f1); [ "$real" -lt $((apparent / 2)) ]'
  show "表观/实际大小" 'ls -lh "$OVERLAY"; du -h "$OVERLAY"'
else
  # 与平台 ensureOverlay 一致：rootless 建 ext3 需 fakeroot，失败回退目录 overlay
  printf '  \033[1;33mINFO\033[0m  overlay create 失败，回退目录式 overlay（与平台行为一致）\n'
  sed 's/^/        /' /tmp/asmoke.out | head -3
  rm -f "$OVERLAY" 2>/dev/null
  mkdir -p "$OVERLAY"
  PASS=$((PASS + 1)); printf '  \033[1;32mPASS\033[0m  %s\n' "overlay 目录就绪（fallback）"
fi

# 2. instance start（SshExecutor.startInstance）
step "2. instance start（隔离参数: ${ISOLATION[*]:-无}）"
check "instance start" '${START_BASE} --overlay "$OVERLAY" "$IMAGE" "$INSTANCE"'
check "instance list 可见 RUNNING" 'apptainer instance list | grep -q "$INSTANCE"'
show "instance list" 'apptainer instance list'
if ! apptainer instance list | grep -q "$INSTANCE"; then
  echo "  ⚠️  实例未存活。常见原因："
  echo "     a) 镜像缺少 %startscript 保活（直接 docker 镜像 build 且无 .def 时，instance 秒退）"
  echo "        → 用 .def 配方重建，并加:  %startscript  exec sleep infinity"
  echo "     b) 第 1 步 overlay 不可用（本脚本已自动回退目录 overlay，见上）"
fi

# 3. 工作区写入 —— rootless 下的关键验证点
step "3. /workspace 写入（writeFile 的 base64 管道；rootless 需 fakeroot）"
check "mkdir -p + base64 -d 写 /workspace/hello.txt" 'apptainer exec "instance://$INSTANCE" sh -c "mkdir -p /workspace && echo aGVsbG8K | base64 -d > /workspace/hello.txt"'
echo "  (若此步 Permission denied：实例 start 需加 --fakeroot，或改用目录式 overlay)"

# 4. 读 / 存在性 / 列表 / stat
step "4. 文件操作（readFile / access / readdir / stat）"
check "readFile: base64 /workspace/hello.txt → aGVsbG8K" 'apptainer exec "instance://$INSTANCE" base64 /workspace/hello.txt 2>/dev/null | grep -q "^aGVsbG8K$"'
check "readFile 兜底: cat | base64" 'apptainer exec "instance://$INSTANCE" cat /workspace/hello.txt | base64 | grep -q "^aGVsbG8K$"'
check "access: test -e /workspace/hello.txt" 'apptainer exec "instance://$INSTANCE" test -e /workspace/hello.txt'
check "readdir: ls -1 /workspace 含 hello.txt" 'apptainer exec "instance://$INSTANCE" ls -1 /workspace | grep -q "^hello.txt$"'
check "stat: %F %s %Y → regular file" 'apptainer exec "instance://$INSTANCE" stat -c "%F %s %Y" /workspace/hello.txt | grep -q "regular file"'

# 5. exec（bash 工具：cd <cwd> && <command>；非 0 退出透传）
step "5. exec（含 cwd 前缀 + 退出码透传）"
check "cd /workspace && pwd → /workspace" 'apptainer exec "instance://$INSTANCE" sh -c "cd /workspace && pwd" | grep -q "^/workspace$"'
check_fails "cd /tmp && false → 退出码非 0" 'apptainer exec "instance://$INSTANCE" sh -c "cd /tmp && false"'

# 6. 持久化（覆盖层跨 stop/start 保留）
step "6. 持久化（stop → start 后文件仍在 overlay 里）"
check "instance stop" 'apptainer instance stop "$INSTANCE"'
check "instance start（重启）" '${START_BASE} --overlay "$OVERLAY" "$IMAGE" "$INSTANCE"'
check "test -e /workspace/hello.txt（PERSIST-OK）" 'apptainer exec "instance://$INSTANCE" test -e /workspace/hello.txt'

# 7. snapshot / restore（Stop-Then-Copy；cp --sparse=always 保稀疏）
step "7. snapshot / restore（复制 overlay + 宿主 du 统计大小）"
check "instance stop（快照前停实例，模拟服务流程）" 'apptainer instance stop "$INSTANCE"'
check "cp -a --sparse=always → 快照" 'rm -rf "$SNAP" && cp -a --sparse=always "$OVERLAY" "$SNAP"'
check "du -sb 快照目录 → 数字" 'du -sb "$SNAP" | cut -f1 | grep -qE "^[0-9]+$"'
show "快照大小（du -sb，稀疏 ext3 报表观大小≈${DISK_GB}G；目录 overlay 报实际字节）" 'du -sb "$SNAP" | cut -f1'
check "restore: rm overlay + cp 快照回来" 'rm -rf "$OVERLAY" && cp -a --sparse=always "$SNAP" "$OVERLAY"'
check "restore: 重启实例" '${START_BASE} --overlay "$OVERLAY" "$IMAGE" "$INSTANCE"'
check "restore 后文件仍在（RESTORE-OK）" 'apptainer exec "instance://$INSTANCE" test -e /workspace/hello.txt'

# 8. workspace 种子（create 带 seedFromPath 时：--bind <seed>:/workspace）
step "8. workspace 种子 bind（--bind <seed>:/workspace）"
check "准备种子目录" 'rm -rf "$SEED_DIR" && mkdir -p "$SEED_DIR" && cp /etc/hostname "$SEED_DIR/seed-marker"'
check "instance stop（重新 bind 启动）" 'apptainer instance stop "$INSTANCE"'
check "instance start --bind seed:/workspace" '${START_BASE} --overlay "$OVERLAY" --bind "$SEED_DIR:/workspace" "$IMAGE" "$INSTANCE"'
check "/workspace 可见种子文件" 'apptainer exec "instance://$INSTANCE" ls -1 /workspace | grep -q "^seed-marker$"'

# 9. destroy（SshExecutor.destroy 的命令序列）
step "9. destroy（instance stop || true + rm overlay）"
check "destroy 命令序列" 'apptainer instance stop "$INSTANCE" 2>/dev/null || true; rm -rf "$OVERLAY"'
check "实例已消失" '! apptainer instance list | grep -q "$INSTANCE"'

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
if [ "${SKIP_CLEANUP:-0}" != "1" ]; then
  check "清理快照/种子残留" 'rm -rf "$SNAP" "$SEED_DIR"'
fi

printf '\n\033[1m==== 结果: %d PASS / %d FAIL ====\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[1;31m失败项:\033[0m\n'
  for f in "${FAILED[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
