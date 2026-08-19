#!/bin/sh
set -eu

# Reconcile runtime egress rules before dropping privileges. This requires
# NET_ADMIN, which the managed-node Compose service grants to this container.
if [ "${MCP_EGRESS_ENFORCE:-}" = "true" ]; then
  /usr/local/bin/reconcile-runtime-egress apply || {
    echo "Failed to reconcile runtime egress rules; refusing to start managed node." >&2
    exit 1
  }
fi

# The Compose service starts as root so it can repair the mounted state root
# before dropping to the daemon identity. Existing workspace data keeps its
# original ownership; only the daemon's own state directory is normalized.
daemon_state_dir="${DOFE_AGENT_DAEMON_STATE_DIR:-${MANAGED_NODE_STATE_DIR:-}}"
if [ -n "$daemon_state_dir" ] && [ -d "$daemon_state_dir" ]; then
  # The state root can contain workspace data created by the host user or an
  # older daemon image. Normalize the complete tree before dropping privileges
  # so queued installs can create their operation directories reliably.
  chown -R 10001:10001 "$daemon_state_dir"
fi

# Docker Desktop commonly exposes the mounted socket as root:root. Retain the
# unprivileged daemon UID while adding only the socket's group for Docker IPC.
socket_gid=""
if [ -S /var/run/docker.sock ]; then
  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
fi

if [ -n "$socket_gid" ] && [ "$socket_gid" != "10001" ]; then
  exec setpriv --reuid 10001 --regid 10001 --groups "10001,$socket_gid" "$@"
fi

exec setpriv --reuid 10001 --regid 10001 --clear-groups "$@"
