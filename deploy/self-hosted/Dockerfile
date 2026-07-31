FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    PNPM_CONFIG_REPLACE_REGISTRY_HOST=always

WORKDIR /srv/DofeAgent

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy

RUN corepack enable \
  && corepack prepare pnpm@10.26.2 --activate \
  && pnpm install --frozen-lockfile --ignore-scripts

ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}

RUN pnpm --filter dofe-agent-daemon run build \
  && pnpm --filter @dofe-agent/web run build

FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production

WORKDIR /srv/DofeAgent

RUN corepack enable \
  && corepack prepare pnpm@10.26.2 --activate

COPY --from=build /srv/DofeAgent /srv/DofeAgent

RUN mkdir -p /srv/DofeAgent/data \
  && chown -R node:node /srv/DofeAgent

USER node

FROM runtime AS web

EXPOSE 1455

CMD ["pnpm", "run", "start:web"]

FROM runtime AS daemon

USER root

ARG PROVIDER_INSTALL_COMMAND

RUN test -n "$PROVIDER_INSTALL_COMMAND" \
  && /bin/sh -ceu "$PROVIDER_INSTALL_COMMAND"

COPY deploy/self-hosted/start-daemon.sh /usr/local/bin/start-dofe-daemon

RUN chmod 0555 /usr/local/bin/start-dofe-daemon \
  && chown node:node /usr/local/bin/start-dofe-daemon

USER node

ENTRYPOINT ["/usr/local/bin/start-dofe-daemon"]
