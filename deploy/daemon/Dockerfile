FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS daemon-build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_registry=https://registry.npmmirror.com

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli ./apps/cli
COPY packages ./packages

RUN --mount=type=cache,id=dofe-local-runtime-pnpm,target=/pnpm/store \
  npm install --global pnpm@10.26.2 \
  && pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm --filter dofe-agent-daemon run build \
  && mkdir -p /opt/daemon-package \
  && npm_config_ignore_scripts=true pnpm --filter dofe-agent-daemon pack --pack-destination /opt/daemon-package

FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_registry=https://registry.npmmirror.com

ARG PROVIDER_INSTALL_COMMAND

RUN groupadd --gid 10001 dofe-agent \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/dofe-agent --shell /usr/sbin/nologin dofe-agent \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@10.26.2

COPY --from=daemon-build /opt/daemon-package/dofe-agent-daemon-*.tgz /tmp/

RUN --mount=type=cache,id=dofe-local-runtime-provider-cli,target=/pnpm/store \
  mkdir -p /opt/dofe-agent-daemon \
  && tar -xzf /tmp/dofe-agent-daemon-*.tgz -C /opt/dofe-agent-daemon --strip-components=1 \
  && rm /tmp/dofe-agent-daemon-*.tgz \
  && ln -s /opt/dofe-agent-daemon/bin/agent-router.js /usr/local/bin/agent-router \
  && ln -s /opt/dofe-agent-daemon/bin/dofe-agent.js /usr/local/bin/dofe-agent \
  && ln -s /opt/dofe-agent-daemon/bin/dofe-agent-daemon.js /usr/local/bin/dofe-agent-daemon \
  && test -n "$PROVIDER_INSTALL_COMMAND" \
  && /bin/sh -ceu "$PROVIDER_INSTALL_COMMAND" \
  && mkdir -p /var/lib/dofe-agent-daemon \
  && chown -R dofe-agent:dofe-agent /home/dofe-agent /var/lib/dofe-agent-daemon \
  && chmod 0755 /opt/dofe-agent-daemon/bin/*.js

ENV HOME=/home/dofe-agent \
    DOFE_AGENT_DAEMON_STATE_DIR=/var/lib/dofe-agent-daemon \
    NODE_ENV=production

USER dofe-agent

ENTRYPOINT ["dofe-agent-daemon", "start", "--foreground"]
