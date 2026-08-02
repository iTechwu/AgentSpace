#!/usr/bin/env bash
# Prepares the signed test image for the real-Docker skill-service E2E
# (src/skill-service/e2e-real-docker.test.ts):
#   1. tiny busybox httpd image → build → push to a local registry
#   2. cosign keypair + sign the pushed image
#   3. writes dofe-svc-e2e.env with DOFE_AGENT_E2E_IMAGE_REF / DOFE_AGENT_E2E_COSIGN_PUB_FILE
#
# Requires: docker (daemon running), cosign, and a writable registry.
# Usage:  bash scripts/dofe-svc-e2e-setup.sh
# Then:   set -a; source dofe-svc-e2e.env; set +a
#         DOFE_AGENT_RUN_DOCKER_E2E=1 ../../node/... e2e-real-docker.test.ts
set -euo pipefail

# 127.0.0.1 (not localhost): on macOS localhost may resolve to ::1 first and the
# registry only listens on IPv4 loopback → curl gets 403. cosign uses its own
# HTTP client so the ref must point at a reachable host.
REGISTRY="${DOFE_AGENT_E2E_REGISTRY:-127.0.0.1:5000}"
IMAGE_TAG="dofe-svc-e2e:1.0.0"
WORK="$(mktemp -d /tmp/dofe-svc-e2e.XXXXXX)"
COSIGN_BIN="${COSIGN_BIN:-cosign}"
OUT_ENV="${DOFE_AGENT_E2E_ENV_FILE:-$(dirname "$0")/dofe-svc-e2e.env}"

echo "== cosign check =="
"$COSIGN_BIN" version >/dev/null

echo "== registry reachable =="
curl -fsS "http://${REGISTRY}/v2/" >/dev/null

echo "== build + push $REGISTRY/$IMAGE_TAG =="
cat > "$WORK/Dockerfile" <<'EOF'
FROM busybox:1.36
RUN mkdir -p /www && printf 'ok\n' > /www/healthz && printf 'hello dofe\n' > /www/index.html
CMD ["httpd", "-f", "-v", "-p", "8080", "-h", "/www"]
EOF
docker build -q -t "$REGISTRY/$IMAGE_TAG" "$WORK" >/dev/null
docker push -q "$REGISTRY/$IMAGE_TAG" >/dev/null

echo "== image digest =="
IMAGE_REF="$(docker inspect --format "{{index .RepoDigests 0}}" "$REGISTRY/$IMAGE_TAG")"

echo "== cosign keypair =="
export COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"
"$COSIGN_BIN" generate-key-pair --output-key-prefix "$WORK/e2e" >/dev/null

echo "== cosign sign (tlog upload off; local registry) =="
"$COSIGN_BIN" sign \
  --key "$WORK/e2e.key" \
  --tlog-upload=false \
  --allow-insecure-registry \
  "$REGISTRY/$IMAGE_TAG" >/dev/null

echo "== verify signature against the public key =="
"$COSIGN_BIN" verify \
  --key "$WORK/e2e.pub" \
  --insecure-ignore-sct=true \
  --insecure-ignore-tlog=true \
  --allow-insecure-registry \
  "$IMAGE_REF" >/dev/null

# The managed-node docker network the container joins (must exist); matches the
# production daemon's .env MANAGED_RUNTIME_DOCKER_NETWORK when set.
NETWORK="${MANAGED_RUNTIME_DOCKER_NETWORK:-dofe-managed-egress}"
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "== creating docker network $NETWORK =="
  docker network create "$NETWORK" >/dev/null
fi

cat > "$OUT_ENV" <<EOF
DOFE_AGENT_E2E_IMAGE_REF='${IMAGE_REF}'
DOFE_AGENT_E2E_COSIGN_PUB_FILE='${WORK}/e2e.pub'
DOFE_AGENT_SKILL_SERVICE_ALLOWED_REGISTRIES='${REGISTRY}'
COSIGN_BIN='${COSIGN_BIN}'
MANAGED_RUNTIME_DOCKER_NETWORK='${NETWORK}'
EOF
echo "== wrote $OUT_ENV =="
echo "IMAGE_REF=$IMAGE_REF"
echo "COSIGN_PUB_FILE=$WORK/e2e.pub"
echo "Next: set -a; source dofe-svc-e2e.env; set +a; DOFE_AGENT_RUN_DOCKER_E2E=1 node --test src/skill-service/e2e-real-docker.test.ts"
