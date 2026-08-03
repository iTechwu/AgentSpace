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
