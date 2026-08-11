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

OVERLAY="${OVERLAY_DIR}/${INSTANCE}.ext3"
SNAP="${OVERLAY}.snap-smoke"

# 生产执行器变体:
#   ssh:           --contain --no-mount hostfs,cwd --cpus N --memory MM
#   apptainer-cli: 无隔离参数（同机部署）
ISOLATION=("--contain" "--no-mount" "hostfs,cwd")
for arg in "$@"; do
  case "$arg" in
    --cli) ISOLATION=() ;;
    --skip-cleanup) SKIP_CLEANUP=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# 供 bash -c 命令串引用
export INSTANCE DISK_GB OVERLAY_DIR OVERLAY SNAP IMAGE SEED_DIR

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
if [ ! -f "$IMAGE" ]; then
  echo "  (未找到 $IMAGE，自动 pull alpine:3.20)"
  check "apptainer pull alpine:3.20" 'apptainer pull docker://alpine:3.20 "$IMAGE"'
fi

# 1. overlay 创建（SshExecutor.ensureOverlay；失败自动回退目录式）
step "1. overlay 创建（稀疏 ext3，--size <diskGb*1024> MiB）"
check "apptainer overlay create --size $((DISK_GB * 1024))" 'apptainer overlay create --size $((DISK_GB*1024)) "$OVERLAY"'
check "稀疏文件：du 实际占用远小于 表观大小" 'apparent=$(stat -c %s "$OVERLAY"); real=$(du -sb "$OVERLAY" | cut -f1); [ "$real" -lt $((apparent / 2)) ]'
show "表观/实际大小" 'ls -lh "$OVERLAY"; du -h "$OVERLAY"'
echo "  (若 overlay create 失败，平台会回退为目录 overlay：mkdir -p \"$OVERLAY\")"

# 2. instance start（SshExecutor.startInstance）
step "2. instance start（隔离参数: ${ISOLATION[*]:-无}）"
check "instance start" 'apptainer instance start "${ISOLATION[@]}" --cpus 2 --memory 2048M --overlay "$OVERLAY" "$IMAGE" "$INSTANCE"'
check "instance list 可见 RUNNING" 'apptainer instance list | grep -q "$INSTANCE"'
show "instance list" 'apptainer instance list'

# 3. 工作区写入 —— rootless 下的关键验证点
step "3. /workspace 写入（writeFile 的 base64 管道；rootless 需 fakeroot）"
check "mkdir -p + base64 -d 写 /workspace/hello.txt" 'apptainer exec "$INSTANCE" sh -c "mkdir -p /workspace && echo aGVsbG8K | base64 -d > /workspace/hello.txt"'
echo "  (若此步 Permission denied：实例 start 需加 --fakeroot，或改用目录式 overlay)"

# 4. 读 / 存在性 / 列表 / stat
step "4. 文件操作（readFile / access / readdir / stat）"
check "readFile: base64 /workspace/hello.txt → aGVsbG8K" 'apptainer exec "$INSTANCE" base64 /workspace/hello.txt 2>/dev/null | grep -q "^aGVsbG8K$"'
check "readFile 兜底: cat | base64" 'apptainer exec "$INSTANCE" cat /workspace/hello.txt | base64 | grep -q "^aGVsbG8K$"'
check "access: test -e /workspace/hello.txt" 'apptainer exec "$INSTANCE" test -e /workspace/hello.txt'
check "readdir: ls -1 /workspace 含 hello.txt" 'apptainer exec "$INSTANCE" ls -1 /workspace | grep -q "^hello.txt$"'
check "stat: %F %s %Y → regular file" 'apptainer exec "$INSTANCE" stat -c "%F %s %Y" /workspace/hello.txt | grep -q "regular file"'

# 5. exec（bash 工具：cd <cwd> && <command>；非 0 退出透传）
step "5. exec（含 cwd 前缀 + 退出码透传）"
check "cd /workspace && pwd → /workspace" 'apptainer exec "$INSTANCE" sh -c "cd /workspace && pwd" | grep -q "^/workspace$"'
check_fails "cd /tmp && false → 退出码非 0" 'apptainer exec "$INSTANCE" sh -c "cd /tmp && false"'

# 6. 持久化（覆盖层跨 stop/start 保留）
step "6. 持久化（stop → start 后文件仍在 overlay 里）"
check "instance stop" 'apptainer instance stop "$INSTANCE"'
check "instance start（重启）" 'apptainer instance start "${ISOLATION[@]}" --cpus 2 --memory 2048M --overlay "$OVERLAY" "$IMAGE" "$INSTANCE"'
check "test -e /workspace/hello.txt（PERSIST-OK）" 'apptainer exec "$INSTANCE" test -e /workspace/hello.txt'

# 7. snapshot / restore（Stop-Then-Copy；cp --sparse=always 保稀疏）
step "7. snapshot / restore（复制 overlay + 宿主 du 统计大小）"
check "instance stop（快照前停实例，模拟服务流程）" 'apptainer instance stop "$INSTANCE"'
check "cp -a --sparse=always → 快照" 'rm -rf "$SNAP" && cp -a --sparse=always "$OVERLAY" "$SNAP"'
check "du -sb 快照目录 → 数字" 'du -sb "$SNAP" | cut -f1 | grep -qE "^[0-9]+$"'
show "快照大小（du -sb，稀疏 ext3 报表观大小≈${DISK_GB}G；目录 overlay 报实际字节）" 'du -sb "$SNAP" | cut -f1'
check "restore: rm overlay + cp 快照回来" 'rm -rf "$OVERLAY" && cp -a --sparse=always "$SNAP" "$OVERLAY"'
check "restore: 重启实例" 'apptainer instance start "${ISOLATION[@]}" --cpus 2 --memory 2048M --overlay "$OVERLAY" "$IMAGE" "$INSTANCE"'
check "restore 后文件仍在（RESTORE-OK）" 'apptainer exec "$INSTANCE" test -e /workspace/hello.txt'

# 8. workspace 种子（create 带 seedFromPath 时：--bind <seed>:/workspace）
step "8. workspace 种子 bind（--bind <seed>:/workspace）"
check "准备种子目录" 'rm -rf "$SEED_DIR" && mkdir -p "$SEED_DIR" && cp /etc/hostname "$SEED_DIR/seed-marker"'
check "instance stop（重新 bind 启动）" 'apptainer instance stop "$INSTANCE"'
check "instance start --bind seed:/workspace" 'apptainer instance start "${ISOLATION[@]}" --overlay "$OVERLAY" --bind "$SEED_DIR:/workspace" "$IMAGE" "$INSTANCE"'
check "/workspace 可见种子文件" 'apptainer exec "$INSTANCE" ls -1 /workspace | grep -q "^seed-marker$"'

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
