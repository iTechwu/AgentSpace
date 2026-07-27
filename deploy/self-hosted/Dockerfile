FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS build

WORKDIR /srv/DofeAgent

COPY package.json ./
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy

RUN npm --prefix apps/web ci --ignore-scripts \
  && npm --prefix apps/cli ci --ignore-scripts \
  && npm --prefix packages/db ci --ignore-scripts \
  && npm --prefix packages/services ci --ignore-scripts \
  && npm --prefix packages/daemon ci --ignore-scripts

ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}

RUN npm --prefix packages/daemon run build \
  && npm --prefix apps/web run build

FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS runtime

WORKDIR /srv/DofeAgent

ENV NODE_ENV=production \
    SELF_HOSTED_ATTACHMENT_LOCAL_ROOT=/var/lib/dofe-agent/workspaces \
    ATTACHMENT_LOCAL_ROOT=/var/lib/dofe-agent/workspaces

COPY --from=build /srv/DofeAgent /srv/DofeAgent

RUN mkdir -p /var/lib/dofe-agent/workspaces /srv/DofeAgent/data \
  && chown -R node:node /var/lib/dofe-agent /srv/DofeAgent

USER node

FROM runtime AS web

EXPOSE 1455

CMD ["npm", "run", "start:web"]

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
