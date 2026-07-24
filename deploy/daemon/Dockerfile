FROM node:24-bookworm-slim AS daemon-build

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

FROM node:24-bookworm-slim

ARG PROVIDER_INSTALL_COMMAND

RUN groupadd --gid 10001 agent-space \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent-space --shell /usr/sbin/nologin agent-space

COPY --from=daemon-build /opt/daemon-package/agent-space-daemon-*.tgz /tmp/

RUN npm install --global /tmp/agent-space-daemon-*.tgz \
  && rm /tmp/agent-space-daemon-*.tgz \
  && test -n "$PROVIDER_INSTALL_COMMAND" \
  && /bin/sh -ceu "$PROVIDER_INSTALL_COMMAND" \
  && mkdir -p /var/lib/agent-space-daemon \
  && chown -R agent-space:agent-space /home/agent-space /var/lib/agent-space-daemon

ENV HOME=/home/agent-space \
    AGENT_SPACE_DAEMON_STATE_DIR=/var/lib/agent-space-daemon \
    NODE_ENV=production

USER agent-space

ENTRYPOINT ["agent-space-daemon", "start", "--foreground"]
