# 镜像目录（从零注册）

平台安装后**镜像目录为空**（不再附带演示镜像——种子数据曾指向不存在的 `/srv/apptainer/images/*.sif`，已由迁移 0004 清除）。管理员在管理台「镜像」页注册真实存在的 SIF 后，用户才能创建容器。

## 推荐：注册相对路径（可打包分发）

`sif_path` 支持相对路径——相对 `IMAGE_BASE_DIR`（默认 `./data/images`）。整个目录树随包搬迁时镜像引用不会失效：

```
# 注册（管理台或 admin API），sif_path 填：
ubuntu-22.04.sif                 # → 解析为 <IMAGE_BASE_DIR>/ubuntu-22.04.sif
images/python-3.12.sif           # → 解析为 <IMAGE_BASE_DIR>/images/python-3.12.sif
```

绝对路径仍然可用（SSH 执行器按部署文档语义登记**远端节点**的绝对路径）。

## 三个常用基础镜像的获取

在能联网的 Linux 机器上（或交付给镜像制作者），一行命令从 Docker Hub 拉取并转为 SIF——产物即上述注册所需文件：

```bash
# Ubuntu 22.04 LTS（对应原演示镜像 ubuntu-22.04）
apptainer pull ubuntu-22.04.sif docker://ubuntu:22.04

# Node.js 20（Debian Bookworm；对应原演示镜像 node-20）
apptainer pull node-20.sif docker://node:20-bookworm

# Python 3.12 slim（对应原演示镜像 python-3.12）
apptainer pull python-3.12.sif docker://python:3.12-slim
```

镜像仓库直链（浏览器/ wget 下载）：
- https://hub.docker.com/_/ubuntu（Tags → 22.04）
- https://hub.docker.com/_/node（Tags → 20-bookworm）
- https://hub.docker.com/_/python（Tags → 3.12-slim）

Docker 镜像需经 `apptainer pull` 转换为 SIF；平台只接受 SIF。定制教学镜像建议写一个 def 文件：

```bash
cat > sandbox-base.def <<'EOF'
Bootstrap: docker
From: ubuntu:22.04

%post
    apt-get update && apt-get install -y python3 python3-pip curl git && apt-get clean
EOF
apptainer build sandbox_base.sif sandbox-base.def
```

## 演示环境例外

`EXECUTOR_KIND=mock` 的纯演示部署如需保留三个演示目录项（mock 执行器不触碰真实文件），启动时设 `SEED_DEMO_IMAGES=on`——迁移 0004 会跳过清除。生产部署不要开。

## 注册示例（admin API）

```bash
curl -X POST http://127.0.0.1:3000/api/v1/admin/images \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{
    "name": "ubuntu-22.04",
    "display_name": "Ubuntu 22.04 LTS",
    "sif_path": "ubuntu-22.04.sif",
    "is_public": true,
    "default_resources": { "cpu": 1, "memoryMb": 1024, "diskGb": 5 }
  }'
```
