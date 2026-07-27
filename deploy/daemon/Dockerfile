FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim AS daemon-build

WORKDIR /workspace

COPY apps/cli ./apps/cli
COPY packages ./packages

RUN npm --prefix apps/cli ci --ignore-scripts \
  && npm --prefix packages/db ci --ignore-scripts \
  && npm --prefix packages/services ci --ignore-scripts \
  && npm --prefix packages/daemon ci --ignore-scripts \
  && npm --prefix packages/daemon run build \
  && mkdir -p /opt/daemon-package \
  && npm --prefix packages/daemon pack --ignore-scripts --pack-destination /opt/daemon-package

FROM uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim

ARG PROVIDER_INSTALL_COMMAND

RUN groupadd --gid 10001 dofe-agent \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/dofe-agent --shell /usr/sbin/nologin dofe-agent

COPY --from=daemon-build /opt/daemon-package/dofe-agent-daemon-*.tgz /tmp/

RUN npm install --global /tmp/dofe-agent-daemon-*.tgz \
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
