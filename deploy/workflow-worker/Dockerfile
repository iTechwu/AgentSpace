FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    PNPM_CONFIG_REPLACE_REGISTRY_HOST=always

WORKDIR /srv/DofeAgent

RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/workflow-worker ./apps/workflow-worker
COPY packages ./packages
# readiness 探针（与 self-hosted 共用同一脚本；本镜像只拷入 worker 子集，
# 不含整个 deploy/ 目录）
COPY deploy/self-hosted/healthcheck.mjs ./deploy/self-hosted/healthcheck.mjs

RUN npm install --global pnpm@10.26.2 \
  && pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter @dofe-agent/db run prisma:generate \
  && chown -R node:node /srv/DofeAgent

USER node

CMD ["pnpm", "--filter", "@dofe-agent/workflow-worker", "start"]
