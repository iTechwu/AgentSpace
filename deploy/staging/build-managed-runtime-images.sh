#!/usr/bin/env bash
# Build the managed-runtime container images and tag them into the namespace the
# AgentSpace daemon actually pulls (`dofe/agent-runtime-<provider>:<tag>`).
#
# Why this exists: deploy/daemon/docker-compose.runtimes.yml builds
# `dofe-agent-runtime-<provider>:local` (hyphen, no namespace), but the daemon
# provisioning templates (packages/services/src/runtime-provisioning/provider-templates.ts)
# and the egress release gate expect `dofe/agent-runtime-<provider>:<tag>` (slash).
# This script bridges that gap so a managed daemon node can pull a local image.
#
# Usage:
#   MANAGED_RUNTIME_IMAGE_TAG=latest ./deploy/staging/build-managed-runtime-images.sh [provider...]
#   # provider defaults to all five: codex claude openclaw hermes deepseek-harness
#
# Non-DeepSeek provider install commands are taken from
# *_PROVIDER_INSTALL_COMMAND env vars. DeepSeek instead requires an externally
# built, digest-pinned JSON-RPC bundle.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${MANAGED_RUNTIME_IMAGE_TAG:-latest}"
DAEMON_COMPOSE="$REPO_ROOT/deploy/daemon/docker-compose.runtimes.yml"

PROVIDERS=("${@:-codex claude openclaw hermes deepseek-harness}")
if [ $# -eq 0 ]; then PROVIDERS=(codex claude openclaw hermes deepseek-harness); fi

default_install_command() {
  case "$1" in
    codex)    echo "pnpm add --global @openai/codex@0.145.0" ;;
    claude)   echo "pnpm add --global @anthropic-ai/claude-code@latest" ;;
    openclaw) echo "pnpm add --global @openai/codex@latest" ;; # placeholder; replace with real openclaw package
    hermes)   echo "pip install --break-system-packages dofe-hermes" ;; # placeholder; replace with real hermes install
    *) echo ""; return 1 ;;
  esac
}

preflight_deepseek_bundle() {
  local configured_context="${DEEPSEEK_HARNESS_RUNTIME_BUNDLE_CONTEXT:-$REPO_ROOT/deploy/daemon/runtimes/deepseek-jsonrpc/artifacts/linux-amd64}"
  local executable_sha="${DEEPSEEK_JSONRPC_EXECUTABLE_SHA256:-}"
  local ripgrep_sha="${DEEPSEEK_JSONRPC_RIPGREP_SHA256:-}"
  local wheel_sha="${DEEPSEEK_RUNTIME_WHEEL_SHA256:-}"
  local source_commit="${DEEPSEEK_RUNTIME_SOURCE_COMMIT:-}"
  local evidence_output="${DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT:-}"
  local executable_path ripgrep_path provenance_path

  if [[ ! "$executable_sha" =~ ^[a-f0-9]{64}$ ]]; then
    echo "DEEPSEEK_JSONRPC_EXECUTABLE_SHA256 must be an explicit lowercase SHA-256 digest." >&2
    return 1
  fi
  if [[ ! "$ripgrep_sha" =~ ^[a-f0-9]{64}$ ]]; then
    echo "DEEPSEEK_JSONRPC_RIPGREP_SHA256 must be an explicit lowercase SHA-256 digest." >&2
    return 1
  fi
  if [[ ! "$wheel_sha" =~ ^[a-f0-9]{64}$ ]]; then
    echo "DEEPSEEK_RUNTIME_WHEEL_SHA256 must be an explicit lowercase SHA-256 digest." >&2
    return 1
  fi
  if [[ ! "$source_commit" =~ ^[a-f0-9]{40}$ ]]; then
    echo "DEEPSEEK_RUNTIME_SOURCE_COMMIT must be an explicit lowercase Git commit." >&2
    return 1
  fi
  if [ -z "$evidence_output" ] || [[ "$evidence_output" != /* ]]; then
    echo "DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT must be an explicit absolute output path." >&2
    return 1
  fi
  if [ -L "$evidence_output" ]; then
    echo "DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT must not be a symbolic link: $evidence_output" >&2
    return 1
  fi
  if [ ! -d "$(dirname "$evidence_output")" ]; then
    echo "DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT parent directory does not exist: $(dirname "$evidence_output")" >&2
    return 1
  fi
  evidence_output="$(cd "$(dirname "$evidence_output")" && pwd -P)/$(basename "$evidence_output")"
  if [ -L "$configured_context" ] || [ ! -d "$configured_context" ]; then
    echo "DeepSeek JSON-RPC bundle context is not a directory: $configured_context" >&2
    return 1
  fi
  configured_context="$(cd "$configured_context" && pwd)"
  executable_path="$configured_context/dsh-jsonrpc-agent"
  ripgrep_path="$configured_context/dsh-jsonrpc-agent-rg"
  provenance_path="$configured_context/provenance.json"
  if [ ! -x "$executable_path" ] || [ ! -x "$ripgrep_path" ]; then
    echo "DeepSeek JSON-RPC bundle must contain executable dsh-jsonrpc-agent and dsh-jsonrpc-agent-rg files: $configured_context" >&2
    return 1
  fi
  if [ ! -f "$provenance_path" ] || [ -L "$provenance_path" ]; then
    echo "DeepSeek JSON-RPC bundle must contain a regular provenance.json file: $configured_context" >&2
    return 1
  fi

  python3 "$REPO_ROOT/deploy/staging/verify-deepseek-runtime-bundle.py" \
    --context "$configured_context" \
    --wheel-sha256 "$wheel_sha" \
    --executable-sha256 "$executable_sha" \
    --ripgrep-sha256 "$ripgrep_sha" \
    --source-commit "$source_commit"

  export DEEPSEEK_HARNESS_RUNTIME_BUNDLE_CONTEXT="$configured_context"
  export DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT="$evidence_output"
}

verify_deepseek_runtime_image() {
  local image="$1"
  local output="$DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT"
  local temporary
  temporary="$(mktemp "${output}.tmp.XXXXXX")"
  if ! docker run --rm \
    -e DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED=1 \
    "$image" verify-deepseek-release > "$temporary"; then
    rm -f "$temporary"
    echo "DeepSeek managed runtime image failed its release evidence smoke: $image" >&2
    return 1
  fi
  if ! python3 "$REPO_ROOT/deploy/staging/verify-deepseek-runtime-evidence.py" \
    --evidence "$temporary" \
    --wheel-sha256 "$DEEPSEEK_RUNTIME_WHEEL_SHA256" \
    --executable-sha256 "$DEEPSEEK_JSONRPC_EXECUTABLE_SHA256" \
    --ripgrep-sha256 "$DEEPSEEK_JSONRPC_RIPGREP_SHA256" \
    --source-commit "$DEEPSEEK_RUNTIME_SOURCE_COMMIT"; then
    rm -f "$temporary"
    return 1
  fi
  if ! chmod 0444 "$temporary" || ! mv -f "$temporary" "$output"; then
    rm -f "$temporary"
    echo "Unable to atomically publish DeepSeek release evidence: $output" >&2
    return 1
  fi
  echo "    wrote DeepSeek release evidence: $output"
}

echo "==> Building managed-runtime images for: ${PROVIDERS[*]} (tag: $IMAGE_TAG)"

# Export the install commands the compose file reads.
for provider in "${PROVIDERS[@]}"; do
  if [ "$provider" = "deepseek-harness" ]; then
    preflight_deepseek_bundle
    continue
  fi
  var="$(printf '%s_PROVIDER_INSTALL_COMMAND' "$provider" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  if [ -z "${!var:-}" ]; then
    default="$(default_install_command "$provider")" || { echo "Unknown provider: $provider" >&2; exit 1; }
    export "$var=$default"
    echo "    $var not set; using default: $default"
  fi
done

# Build via the existing compose (context = repo root).
docker compose --file "$DAEMON_COMPOSE" build "${PROVIDERS[@]/#/runtime-}"

# Re-tag each built image into the dofe/agent-runtime-<provider>:<tag> namespace.
for provider in "${PROVIDERS[@]}"; do
  src="dofe-agent-runtime-$provider:local"
  dst="dofe/agent-runtime-$provider:$IMAGE_TAG"
  if [ "$provider" = "deepseek-harness" ]; then
    verify_deepseek_runtime_image "$src"
  fi
  docker tag "$src" "$dst"
  echo "    tagged $src -> $dst"
done

echo "==> Done. Managed-runtime images available:"
docker images --filter "reference=dofe/agent-runtime-*" --format "    {{.Repository}}:{{.Tag}}"
