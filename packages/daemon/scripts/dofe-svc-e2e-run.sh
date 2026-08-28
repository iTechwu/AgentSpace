#!/usr/bin/env bash
# Runs the real-Docker skill-service E2E. Source the setup env file first, or the
# script will run the setup for you if the env file is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${DOFE_AGENT_E2E_ENV_FILE:-scripts/dofe-svc-e2e.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "== running setup (no env file yet) =="
  bash scripts/dofe-svc-e2e-setup.sh
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export DOFE_AGENT_RUN_DOCKER_E2E=1
export MANAGED_RUNTIME_DOCKER_NETWORK="${MANAGED_RUNTIME_DOCKER_NETWORK:-dofe-managed-egress}"

NODE_BIN="${DOFE_AGENT_NODE:-$(command -v node)}"
exec "$NODE_BIN" --experimental-strip-types --test src/skill-service/e2e-real-docker.test.ts
