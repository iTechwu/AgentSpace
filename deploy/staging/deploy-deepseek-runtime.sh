#!/usr/bin/env bash
# Verify the signed immutable image with both native models, then deploy that
# exact digest without allowing Compose to pull or rebuild another image.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$REPO_ROOT/deploy/staging/run-deepseek-runtime-canary.sh"

env -u DEEPSEEK_API_KEY docker compose \
  -f "$REPO_ROOT/deploy/daemon/docker-compose.deepseek-runtime.yml" \
  up -d --pull never --no-build runtime-deepseek-harness
