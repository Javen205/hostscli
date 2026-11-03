#!/usr/bin/env bash
#
# Docker Linux 验证：在容器内调用单一验证入口，与本地、CI 保持一致。
#
# 重要限制（不要误判为代码缺陷）：
#   容器里的 /etc/hosts 是 Docker bind mount。对 bind mount 上的文件做
#   rename() 会返回 EBUSY，而本项目用「同目录临时文件 + rename」实现原子写。
#   因此本脚本**从不写 /etc/hosts**：verify 内的冒烟与 e2e 都把 hostsPath
#   指向 /tmp 下的普通文件（临时 --data-dir + 临时 hostsPath）。
#
# 用法（在宿主机仓库根目录）：
#   bash docker/run-linux-verify.sh
#
# 脚本约定：/src 是只读挂载的仓库，/app 是可写副本（避免 Linux 二进制污染宿主 node_modules）。
# 容器内 root 会绕过只读权限位、且镜像未安装 git，相关能力由 verify 内的步骤打印 SKIP 说明。
set -euo pipefail

export CI=true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

SRC=${SRC:-/src}
APP=${APP:-/app}

echo "== Docker Linux 验证 =="
echo "kernel: $(uname -srm)"
echo "node:   $(node -v)"
echo "pnpm:   $(pnpm -v)"
echo "src:    $SRC (只读挂载)"
echo "app:    $APP (容器内可写副本)"
echo

if [ ! -d "$SRC/packages" ]; then
  echo "错误：$SRC 下没有 packages/，请确认已挂载仓库。" >&2
  exit 1
fi

echo "[1/3] 复制仓库到可写目录（排除 node_modules/.git/构建产物）"
mkdir -p "$APP"
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.screenshots \
  --exclude=dist \
  -cf - . | tar -C "$APP" -xf -
cd "$APP"

echo "[2/3] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[3/3] pnpm verify --skip-install（本地 / Docker / CI 同一入口）"
pnpm verify --skip-install

echo
echo "== Docker Linux 验证完成 =="
echo "注意：本验证不覆盖真实提权（容器默认 root）、systemd/DNS 服务、"
echo "      以及真实 /etc/hosts 的写入；详见 docs/verification.md。"
