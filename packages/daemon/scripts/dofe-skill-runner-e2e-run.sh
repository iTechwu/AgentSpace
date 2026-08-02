#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Skill Runner release gate must run on a Linux managed node." >&2
  exit 1
fi

DOCKER_BIN="${DOFE_SKILL_RUNNER_DOCKER_BIN:-docker}"
for key in DOFE_SKILL_RUNNER_NODE_IMAGE DOFE_SKILL_RUNNER_PYTHON_IMAGE DOFE_SKILL_RUNNER_BASH_IMAGE; do
  value="${!key:-}"
  if [[ ! "$value" =~ @sha256:[a-fA-F0-9]{64}$ ]]; then
    echo "$key must be set to repo@sha256:<64-hex>." >&2
    exit 1
  fi
  "$DOCKER_BIN" image inspect "$value" >/dev/null
done

"$DOCKER_BIN" version >/dev/null
export DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1
NODE_BIN="${DOFE_AGENT_NODE:-$(command -v node)}"
exec "$NODE_BIN" --env-file-if-exists=../../.env --experimental-strip-types --test --test-concurrency=1 \
  src/skill-runner.e2e-real-docker.test.ts
