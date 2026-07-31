#!/bin/sh
set -eu

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
