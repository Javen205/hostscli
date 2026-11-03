FROM node:24.12.0-bookworm

# corepack 固定 pnpm 版本，和 package.json 的 packageManager 保持一致。
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# 仓库通过 /src 只读挂载；verify.sh 会复制到 /app 后再安装依赖。
CMD ["bash", "/src/docker/verify.sh"]
