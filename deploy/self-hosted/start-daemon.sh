#!/bin/sh
set -eu

: "${DOFE_AGENT_WORKSPACE_ID:?DOFE_AGENT_WORKSPACE_ID is required}"
: "${DOFE_AGENT_DAEMON_ID:?DOFE_AGENT_DAEMON_ID is required}"

exec node --experimental-strip-types apps/cli/src/index.ts daemon start \
  --foreground \
  --mode local \
  --workspace-id "$DOFE_AGENT_WORKSPACE_ID" \
  --daemon-id "$DOFE_AGENT_DAEMON_ID" \
  --device-name "${DOFE_AGENT_DEVICE_NAME:-$DOFE_AGENT_DAEMON_ID}" \
  --runtime-name "${DOFE_AGENT_RUNTIME_NAME:-DofeAgent Docker Runtime}" \
  --heartbeat-interval "${DOFE_AGENT_HEARTBEAT_INTERVAL_MS:-15000}" \
  --task-timeout "${DOFE_AGENT_TASK_TIMEOUT_MS:-43200000}"
