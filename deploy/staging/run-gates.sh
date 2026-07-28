#!/usr/bin/env bash
# Run the managed-runtime release gates against the staging environment.
#
# Gates (defined in deploy/self-hosted/):
#   - verify-managed-runtime-egress.mjs : network label + egress isolation probes.
#   - verify-managed-runtime-billing.mjs: reconciles a real gateway usage record.
#
# Prereqs (see README.md):
#   - .env.staging fully filled in (models + network + vault + STAGING_* evidence)
#   - the labelled egress network created (setup-egress-network.sh)
#   - the dofe/agent-runtime-<provider>:<tag> image built (build-managed-runtime-images.sh)
#   - a REAL chat run through the managed runtime has produced the gateway request
#     whose id = STAGING_GATEWAY_REQUEST_ID (the billing gate reconciles it)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${STAGING_ENV_FILE:-$REPO_ROOT/deploy/staging/.env.staging}"
GATES_DIR="$REPO_ROOT/deploy/self-hosted"

if [ ! -f "$ENV_FILE" ]; then
  echo "!! $ENV_FILE not found. Copy .env.staging.example and fill it in." >&2
  exit 1
fi

# Node --env-file loads the file into process.env (the verify scripts read env).
NODE_ARGS=(--env-file="$ENV_FILE" --experimental-strip-types)
GATES=("${@:-egress billing}")
if [ $# -eq 0 ]; then GATES=(egress billing); fi

run_gate() {
  case "$1" in
    egress)  echo "==> egress gate";  node "${NODE_ARGS[@]}" "$GATES_DIR/verify-managed-runtime-egress.mjs" ;;
    billing) echo "==> billing gate"; node "${NODE_ARGS[@]}" "$GATES_DIR/verify-managed-runtime-billing.mjs" ;;
    *) echo "Unknown gate: $1 (expected: egress|billing)" >&2; exit 1 ;;
  esac
}

for gate in "${GATES[@]}"; do
  run_gate "$gate"
  echo
done

echo "==> All requested gates completed. Evidence under: ${MANAGED_RUNTIME_EVIDENCE_DIR:-artifacts/managed-runtime}"
