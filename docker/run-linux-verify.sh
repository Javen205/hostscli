#!/usr/bin/env bash
#
# 宿主机入口：构建镜像并运行 Docker Linux 验证。
# 仓库以只读方式挂载到 /src，容器内复制到 /app 安装依赖，
# 避免 Linux 版 node_modules 污染宿主目录。
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${IMAGE:-hostscli-linux-verify:local}

echo "==> docker build ($IMAGE)"
start=$(date +%s)
docker build -t "$IMAGE" "$REPO_ROOT/docker"
build_seconds=$(( $(date +%s) - start ))
echo "==> 镜像构建耗时: ${build_seconds}s"

echo "==> docker run (mount $REPO_ROOT -> /src:ro)"
start=$(date +%s)
# 命名卷缓存 pnpm 包与 corepack 下载，重复验证不必重新下载全部依赖。
docker run --rm \
  -v "$REPO_ROOT":/src:ro \
  -v hostscli-pnpm-store:/root/.local/share/pnpm \
  -v hostscli-corepack-cache:/root/.cache/node/corepack \
  "$IMAGE" \
  bash /src/docker/verify.sh
run_seconds=$(( $(date +%s) - start ))
echo "==> 容器内验证耗时: ${run_seconds}s"
