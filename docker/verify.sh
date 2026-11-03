#!/usr/bin/env bash
#
# Docker Linux 验证：在容器内跑完整闸门 + 临时 hostsPath 冒烟。
#
# 重要限制（不要误判为代码缺陷）：
#   容器里的 /etc/hosts 是 Docker bind mount。对 bind mount 上的文件做
#   rename() 会返回 EBUSY，而本项目用「同目录临时文件 + rename」实现原子写。
#   因此本脚本**从不写 /etc/hosts**，而是通过 `config set hostsPath` 把
#   hosts 指向 /tmp/hosts-cli-test/hosts（普通文件），冒烟断言全部基于该文件。
#
# 用法（在宿主机仓库根目录）：
#   bash docker/run-linux-verify.sh
#
# 脚本约定：/src 是只读挂载的仓库，/app 是可写副本（避免 Linux 二进制污染宿主 node_modules）。
set -euo pipefail

export CI=true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

SMOKE_ROOT=/tmp/hosts-cli-test
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

echo "[1/7] 复制仓库到可写目录（排除 node_modules/.git/构建产物）"
mkdir -p "$APP"
tar -C "$SRC" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.screenshots \
  --exclude=dist \
  -cf - . | tar -C "$APP" -xf -
cd "$APP"

echo "[2/7] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[3/7] pnpm build"
pnpm build

echo "[4/7] pnpm typecheck"
pnpm typecheck

echo "[5/7] pnpm lint"
pnpm lint

echo "[6/7] pnpm test"
pnpm test

echo "[7/7] pnpm format:check + 冒烟"
pnpm format:check

rm -rf "$SMOKE_ROOT"
node scripts/smoke-ci.mjs

echo
echo "== Docker Linux 验证完成 =="
echo "注意：本验证不覆盖真实提权（容器默认 root）、systemd/DNS 服务、"
echo "      以及真实 /etc/hosts 的写入；详见 docs/verification.md。"
