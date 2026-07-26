#!/usr/bin/env bash
#
# Low-ops control for the Mac dev daemon.
#
# The local daemon (`daemon start --mode local`) embeds the Feishu WebSocket
# worker, so starting the daemon alone gives you both the runtime executors
# (claude/codex/openclaw/opencode) AND the Feishu bridge. One command, not many.
#
# We run it via nohup in the foreground user environment (not launchd) because
# the daemon needs the interactive PATH to detect provider CLIs, and launchd's
# minimal session repeatedly failed to spawn it on this machine.
#
# Usage:
#   scripts/dev-daemons.sh start     # start the daemon in the background (logs → data/daemon/daemon.log)
#   scripts/dev-daemons.sh stop      # stop it
#   scripts/dev-daemons.sh restart   # stop + start
#   scripts/dev-daemons.sh status    # is it running?
#   scripts/dev-daemons.sh run <name># run one in the foreground (internal / ad-hoc): local-daemon | feishu-worker
#
# The CLI auto-loads <repo>/.env (DB url, Feishu credential key).
set -euo pipefail

REPO="/Users/techwu/Documents/codes/dofe.ai/agentspace.dofe.ai"
NODE_BIN="/Users/techwu/.local/opt/node-v24.9.0-darwin-arm64/bin/node"
CLI="$REPO/apps/cli/src/index.ts"
WORKSPACE_ID="sso-team-c8c8d97ffcb845311387e967"
PID_FILE="$REPO/data/daemon/dev-daemon.pid"
LOG_FILE="$REPO/data/daemon/daemon.log"

cmd_for_unit() {
  case "${1:-}" in
    local-daemon)
      echo "$NODE_BIN --experimental-strip-types $CLI daemon start --foreground --mode local --daemon-id yootun-local-20260725 --device-name Yootun\ Local --runtime-name Yootun\ Local\ Runtime --heartbeat-interval 15000 --task-timeout 43200000 --workspace-id $WORKSPACE_ID"
      ;;
    feishu-worker)
      echo "$NODE_BIN --experimental-strip-types $CLI integrations feishu worker --workspace-id $WORKSPACE_ID"
      ;;
    *) echo "unknown unit: ${1:-}" >&2; exit 2 ;;
  esac
}

run_unit() {
  cd "$REPO"
  case "${1:-}" in
    local-daemon) exec "$NODE_BIN" --experimental-strip-types "$CLI" daemon start \
        --foreground --mode local --daemon-id yootun-local-20260725 \
        --device-name "Yootun Local" --runtime-name "Yootun Local Runtime" \
        --heartbeat-interval 15000 --task-timeout 43200000 --workspace-id "$WORKSPACE_ID" ;;
    feishu-worker) exec "$NODE_BIN" --experimental-strip-types "$CLI" integrations feishu worker --workspace-id "$WORKSPACE_ID" ;;
    *) echo "unknown unit: ${1:-}" >&2; exit 2 ;;
  esac
}

is_running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; }

do_start() {
  cd "$REPO"
  if is_running; then echo "already running (pid $(cat "$PID_FILE"))"; return 0; fi
  rm -f "$PID_FILE"
  mkdir -p "$(dirname "$LOG_FILE")"
  # nohup + disown: survives terminal close; inherits the interactive environment.
  nohup "$NODE_BIN" --experimental-strip-types "$CLI" daemon start \
      --foreground --mode local --daemon-id yootun-local-20260725 \
      --device-name "Yootun Local" --runtime-name "Yootun Local Runtime" \
      --heartbeat-interval 15000 --task-timeout 43200000 --workspace-id "$WORKSPACE_ID" \
      >> "$LOG_FILE" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"
  sleep 3
  if kill -0 "$pid" 2>/dev/null; then
    echo "started dev daemon (pid $pid); logs → $LOG_FILE"
  else
    echo "FAILED to start — tail of log:" >&2; tail -15 "$LOG_FILE" >&2; rm -f "$PID_FILE"; exit 1
  fi
}

do_stop() {
  if is_running; then
    local pid; pid=$(cat "$PID_FILE")
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "stopped dev daemon (pid $pid)"
  else
    rm -f "$PID_FILE"; echo "not running"
  fi
}

do_status() {
  if is_running; then echo "running (pid $(cat "$PID_FILE"))"; else echo "not running"; fi
}

case "${1:-}" in
  run) shift; run_unit "$@" ;;
  cmd) shift; cmd_for_unit "$@" ;;   # prints the command line for a unit (handy for copy-paste / launchd)
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  *) echo "usage: $0 {start|stop|restart|status|run <name>|cmd <name>}" >&2; exit 2 ;;
esac
