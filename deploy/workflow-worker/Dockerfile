FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    PNPM_CONFIG_REPLACE_REGISTRY_HOST=always

WORKDIR /srv/DofeAgent

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/workflow-worker ./apps/workflow-worker
COPY packages ./packages

RUN npm install --global pnpm@10.26.2 \
  && pnpm install --frozen-lockfile --ignore-scripts \
  && chown -R node:node /srv/DofeAgent

USER node

CMD ["pnpm", "--filter", "@dofe-agent/workflow-worker", "start"]
