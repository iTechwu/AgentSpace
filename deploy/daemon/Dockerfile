FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS daemon-build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli ./apps/cli
COPY packages ./packages

RUN corepack enable \
  && corepack prepare pnpm@10.26.2 --activate \
  && pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter dofe-agent-daemon run build \
  && mkdir -p /opt/daemon-package \
  && pnpm --filter dofe-agent-daemon pack --ignore-scripts --pack-destination /opt/daemon-package

FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

ARG PROVIDER_INSTALL_COMMAND

RUN groupadd --gid 10001 dofe-agent \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/dofe-agent --shell /usr/sbin/nologin dofe-agent

COPY --from=daemon-build /opt/daemon-package/dofe-agent-daemon-*.tgz /tmp/

RUN corepack enable \
  && corepack prepare pnpm@10.26.2 --activate \
  && pnpm add --global /tmp/dofe-agent-daemon-*.tgz \
  && rm /tmp/dofe-agent-daemon-*.tgz \
  && test -n "$PROVIDER_INSTALL_COMMAND" \
  && /bin/sh -ceu "$PROVIDER_INSTALL_COMMAND" \
  && mkdir -p /var/lib/dofe-agent-daemon \
  && chown -R dofe-agent:dofe-agent /home/dofe-agent /var/lib/dofe-agent-daemon

ENV HOME=/home/dofe-agent \
    DOFE_AGENT_DAEMON_STATE_DIR=/var/lib/dofe-agent-daemon \
    NODE_ENV=production

USER dofe-agent

ENTRYPOINT ["dofe-agent-daemon", "start", "--foreground"]
