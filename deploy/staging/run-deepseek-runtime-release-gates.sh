#!/usr/bin/env bash
# Release gate for the signed DeepSeek runtime: real canary/deploy first,
# then an independently queried terminal billing record for a real task.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

required() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the DeepSeek release gate." >&2
    exit 1
  fi
}

required DEEPSEEK_RUNTIME_IMAGE
required DEEPSEEK_RUNTIME_IMAGE_REPOSITORY
required DEEPSEEK_RUNTIME_IMAGE_SHA256
required DEEPSEEK_API_KEY
required DEEPSEEK_RUNTIME_RELEASE_EVIDENCE
required DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY
required DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY_SHA256
required DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT
required MODELS_BASE_URL
required MODELS_GATEWAY_BASE_URL
required STAGING_MODELS_TENANT_ID
required STAGING_RUNTIME_CREDENTIAL_ID
required STAGING_RUNTIME_ID
required STAGING_EMPLOYEE_ID
required STAGING_CONVERSATION_ID
required STAGING_GATEWAY_REQUEST_ID
required STAGING_EXPECTED_MODEL
required STAGING_BILLING_START_DATE

case "$STAGING_EXPECTED_MODEL" in
  deepseek-v4-flash|deepseek-v4-pro) ;;
  *)
    echo "STAGING_EXPECTED_MODEL must be deepseek-v4-flash or deepseek-v4-pro." >&2
    exit 1
    ;;
esac

MODELS_DEEPSEEK_BASE_URL="$(python3 - "$MODELS_GATEWAY_BASE_URL" <<'PY'
from urllib.parse import urlsplit
import sys

url = urlsplit(sys.argv[1].strip())
if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
    raise SystemExit("MODELS_GATEWAY_BASE_URL must be credential-free HTTPS without query or fragment")
base = url.geturl().rstrip("/")
print(f"{base}/v1")
PY
)"
if [ -n "${DEEPSEEK_BASE_URL:-}" ] && [ "$DEEPSEEK_BASE_URL" != "$MODELS_DEEPSEEK_BASE_URL" ]; then
  echo "DEEPSEEK_BASE_URL must equal MODELS_GATEWAY_BASE_URL/v1 in the managed release gate." >&2
  exit 1
fi
export DEEPSEEK_BASE_URL="$MODELS_DEEPSEEK_BASE_URL"

"$REPO_ROOT/deploy/staging/deploy-deepseek-runtime.sh"

# This query must point at the request produced by a real runtime task. The
# generic gate checks terminal status, attribution, cost, currency, token usage,
# and gateway usage id; it also writes an auditable 0600 evidence record.
node "$REPO_ROOT/deploy/self-hosted/verify-managed-runtime-billing.mjs"
