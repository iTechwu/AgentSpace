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
#   # provider defaults to all four: codex claude openclaw hermes
#
# Provider install commands are taken from *_PROVIDER_INSTALL_COMMAND env vars
# (see deploy/daemon/.env.example). If unset, sensible pnpm defaults are used.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${MANAGED_RUNTIME_IMAGE_TAG:-latest}"
DAEMON_COMPOSE="$REPO_ROOT/deploy/daemon/docker-compose.runtimes.yml"

PROVIDERS=("${@:-codex claude openclaw hermes}")
if [ $# -eq 0 ]; then PROVIDERS=(codex claude openclaw hermes); fi

default_install_command() {
  case "$1" in
    codex)    echo "pnpm add --global @openai/codex@0.145.0" ;;
    claude)   echo "pnpm add --global @anthropic-ai/claude-code@latest" ;;
    openclaw) echo "pnpm add --global @openai/codex@latest" ;; # placeholder; replace with real openclaw package
    hermes)   echo "pip install --break-system-packages dofe-hermes" ;; # placeholder; replace with real hermes install
    *) echo ""; return 1 ;;
  esac
}

echo "==> Building managed-runtime images for: ${PROVIDERS[*]} (tag: $IMAGE_TAG)"

# Export the install commands the compose file reads.
for provider in "${PROVIDERS[@]}"; do
  var="$(printf '%s_PROVIDER_INSTALL_COMMAND' "$provider" | tr '[:lower:]' '[:upper:]')"
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
  docker tag "$src" "$dst"
  echo "    tagged $src -> $dst"
done

echo "==> Done. Managed-runtime images available:"
docker images --filter "reference=dofe/agent-runtime-*" --format "    {{.Repository}}:{{.Tag}}"
