#!/usr/bin/env bash
# Run both native DeepSeek models from an immutable managed-runtime image and
# publish only verified, credential-free canary evidence.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${DEEPSEEK_RUNTIME_IMAGE:-}"
EXPECTED_IMAGE_REPOSITORY="${DEEPSEEK_RUNTIME_IMAGE_REPOSITORY:-}"
EXPECTED_IMAGE_SHA256="${DEEPSEEK_RUNTIME_IMAGE_SHA256:-}"
RELEASE_EVIDENCE="${DEEPSEEK_RUNTIME_RELEASE_EVIDENCE:-}"
OUTPUT="${DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT:-}"
COSIGN_PUBLIC_KEY="${DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY:-}"
EXPECTED_COSIGN_PUBLIC_KEY_SHA256="${DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY_SHA256:-}"
COSIGN_EXECUTABLE="${COSIGN_BIN:-cosign}"
COSIGN_TIMEOUT_SECONDS="${DEEPSEEK_RUNTIME_COSIGN_TIMEOUT_SECONDS:-60}"
CANARY_TIMEOUT_MS="${DOFE_AGENT_DEEPSEEK_MODEL_CANARY_TIMEOUT_MS:-120000}"
HOST_TIMEOUT_SECONDS="${DEEPSEEK_MODEL_CANARY_HOST_TIMEOUT_SECONDS:-}"
MAX_EVIDENCE_BYTES=65536

if [[ ! "$IMAGE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:([a-f0-9]{64})$ ]]; then
  echo "DEEPSEEK_RUNTIME_IMAGE must use an immutable image@sha256 digest." >&2
  exit 1
fi
IMAGE_SHA256="${BASH_REMATCH[1]}"
IMAGE_DIGEST="sha256:$IMAGE_SHA256"
IMAGE_REPOSITORY="${IMAGE%@sha256:*}"
if [[ ! "$EXPECTED_IMAGE_REPOSITORY" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$ ]] \
  || [ "$IMAGE_REPOSITORY" != "$EXPECTED_IMAGE_REPOSITORY" ]; then
  echo "DEEPSEEK_RUNTIME_IMAGE_REPOSITORY must exactly match the approved image repository." >&2
  exit 1
fi
if [[ ! "$EXPECTED_IMAGE_SHA256" =~ ^[a-f0-9]{64}$ ]] || [ "$IMAGE_SHA256" != "$EXPECTED_IMAGE_SHA256" ]; then
  echo "DEEPSEEK_RUNTIME_IMAGE_SHA256 must exactly match the canary image digest." >&2
  exit 1
fi
if [[ ! "$CANARY_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [ "$CANARY_TIMEOUT_MS" -lt 1000 ] || [ "$CANARY_TIMEOUT_MS" -gt 600000 ]; then
  echo "DOFE_AGENT_DEEPSEEK_MODEL_CANARY_TIMEOUT_MS must be an integer between 1000 and 600000." >&2
  exit 1
fi
if [ -z "$HOST_TIMEOUT_SECONDS" ]; then
  HOST_TIMEOUT_SECONDS=$(( (CANARY_TIMEOUT_MS * 2 + 999) / 1000 + 60 ))
elif [[ ! "$HOST_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$HOST_TIMEOUT_SECONDS" -lt 1 ] || [ "$HOST_TIMEOUT_SECONDS" -gt 3600 ]; then
  echo "DEEPSEEK_MODEL_CANARY_HOST_TIMEOUT_SECONDS must be an integer between 1 and 3600." >&2
  exit 1
fi
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "DEEPSEEK_API_KEY is required for the model canary." >&2
  exit 1
fi
if [[ ! "$COSIGN_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$COSIGN_TIMEOUT_SECONDS" -lt 1 ] || [ "$COSIGN_TIMEOUT_SECONDS" -gt 300 ]; then
  echo "DEEPSEEK_RUNTIME_COSIGN_TIMEOUT_SECONDS must be an integer between 1 and 300." >&2
  exit 1
fi
if [[ ! "$EXPECTED_COSIGN_PUBLIC_KEY_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY_SHA256 must be an approved lowercase SHA-256 digest." >&2
  exit 1
fi
if [ -z "$COSIGN_PUBLIC_KEY" ] || [[ "$COSIGN_PUBLIC_KEY" != /* ]] || [ -L "$COSIGN_PUBLIC_KEY" ] || [ ! -f "$COSIGN_PUBLIC_KEY" ]; then
  echo "DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY must be an absolute regular non-symlink file." >&2
  exit 1
fi
if [ -z "$RELEASE_EVIDENCE" ] || [[ "$RELEASE_EVIDENCE" != /* ]] || [ -L "$RELEASE_EVIDENCE" ] || [ ! -f "$RELEASE_EVIDENCE" ]; then
  echo "DEEPSEEK_RUNTIME_RELEASE_EVIDENCE must be an absolute regular non-symlink file." >&2
  exit 1
fi
if [ -z "$OUTPUT" ] || [[ "$OUTPUT" != /* ]] || [ -L "$OUTPUT" ] || { [ -e "$OUTPUT" ] && [ ! -f "$OUTPUT" ]; }; then
  echo "DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT must be an absolute non-symlink output path." >&2
  exit 1
fi
if [ ! -d "$(dirname "$OUTPUT")" ]; then
  echo "DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT parent directory does not exist." >&2
  exit 1
fi
RELEASE_EVIDENCE="$(cd "$(dirname "$RELEASE_EVIDENCE")" && pwd -P)/$(basename "$RELEASE_EVIDENCE")"
COSIGN_PUBLIC_KEY="$(cd "$(dirname "$COSIGN_PUBLIC_KEY")" && pwd -P)/$(basename "$COSIGN_PUBLIC_KEY")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd -P)/$(basename "$OUTPUT")"

PRIVATE_TEMP_DIR="$(mktemp -d /tmp/dofe-deepseek-canary.XXXXXX)"
chmod 0700 "$PRIVATE_TEMP_DIR"
COSIGN_PUBLIC_KEY_SNAPSHOT="$PRIVATE_TEMP_DIR/cosign-public-key.pem"
RELEASE_EVIDENCE_SNAPSHOT="$PRIVATE_TEMP_DIR/release-evidence.json"
TEMPORARY=""
COSIGN_PID=""
DOCKER_PID=""
CONTAINER_NAME=""
CONTAINER_MAY_EXIST=0

terminate_process() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return
  fi
  kill "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + 1))
  while kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  wait "$pid" 2>/dev/null || true
}

remove_container() {
  if [ "$CONTAINER_MAY_EXIST" -ne 1 ] || [ -z "$CONTAINER_NAME" ]; then return; fi
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 &
  local cleanup_pid=$!
  local cleanup_deadline=$((SECONDS + 2))
  while kill -0 "$cleanup_pid" 2>/dev/null && [ "$SECONDS" -lt "$cleanup_deadline" ]; do sleep 0.1; done
  if kill -0 "$cleanup_pid" 2>/dev/null; then terminate_process "$cleanup_pid"; else wait "$cleanup_pid" 2>/dev/null || true; fi
  CONTAINER_MAY_EXIST=0
}

cleanup() {
  if [ -n "$COSIGN_PID" ]; then terminate_process "$COSIGN_PID"; COSIGN_PID=""; fi
  if [ -n "$DOCKER_PID" ]; then terminate_process "$DOCKER_PID"; DOCKER_PID=""; fi
  remove_container
  if [ -n "$TEMPORARY" ]; then rm -f "$TEMPORARY"; fi
  rm -f "$COSIGN_PUBLIC_KEY_SNAPSHOT" "$RELEASE_EVIDENCE_SNAPSHOT"
  rmdir "$PRIVATE_TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$COSIGN_PUBLIC_KEY" "$COSIGN_PUBLIC_KEY_SNAPSHOT" "$RELEASE_EVIDENCE" "$RELEASE_EVIDENCE_SNAPSHOT" <<'PY'
import os
import stat
import sys

def snapshot(source: str, target: str, limit: int) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise ValueError(f"unsafe or oversized release input: {source}")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError(f"oversized release input: {source}")
    finally:
        os.close(descriptor)
    output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    try:
        with os.fdopen(output, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(output)

snapshot(sys.argv[1], sys.argv[2], 16 * 1024)
snapshot(sys.argv[3], sys.argv[4], 64 * 1024)
PY
if ! grep -q '^-----BEGIN PUBLIC KEY-----$' "$COSIGN_PUBLIC_KEY_SNAPSHOT" \
  || ! grep -q '^-----END PUBLIC KEY-----$' "$COSIGN_PUBLIC_KEY_SNAPSHOT"; then
  echo "DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY must be a bounded PEM public key." >&2
  exit 1
fi
COSIGN_PUBLIC_KEY_SHA256="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$COSIGN_PUBLIC_KEY_SNAPSHOT")"
if [ "$COSIGN_PUBLIC_KEY_SHA256" != "$EXPECTED_COSIGN_PUBLIC_KEY_SHA256" ]; then
  echo "DeepSeek runtime cosign public key does not match its approved SHA-256 digest." >&2
  exit 1
fi

COSIGN_ENV=(env -i "PATH=${PATH:-/usr/local/bin:/usr/bin:/bin}")
for key in HOME DOCKER_CONFIG SSL_CERT_FILE SSL_CERT_DIR HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
  if [ -n "${!key:-}" ]; then COSIGN_ENV+=("$key=${!key}"); fi
done
"${COSIGN_ENV[@]}" "$COSIGN_EXECUTABLE" verify \
  --key "$COSIGN_PUBLIC_KEY_SNAPSHOT" \
  --insecure-ignore-sct=true \
  --insecure-ignore-tlog=true \
  "$IMAGE" >/dev/null &
COSIGN_PID=$!
COSIGN_DEADLINE=$((SECONDS + COSIGN_TIMEOUT_SECONDS))
while kill -0 "$COSIGN_PID" 2>/dev/null; do
  if [ "$SECONDS" -ge "$COSIGN_DEADLINE" ]; then
    terminate_process "$COSIGN_PID"
    COSIGN_PID=""
    echo "DeepSeek runtime image signature verification exceeded its host-side deadline." >&2
    exit 1
  fi
  sleep 0.1
done
if ! wait "$COSIGN_PID"; then
  COSIGN_PID=""
  echo "DeepSeek runtime image signature verification failed: $IMAGE" >&2
  exit 1
fi
COSIGN_PID=""

TEMPORARY="$(mktemp "${OUTPUT}.tmp.XXXXXX")"
CONTAINER_NAME="dofe-deepseek-canary-$$-${RANDOM:-0}"

DOCKER_ENV=(
  -e DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED=1
  -e "DOFE_AGENT_DEEPSEEK_RUNTIME_IMAGE_DIGEST=$IMAGE_DIGEST"
  -e "DOFE_AGENT_DEEPSEEK_COSIGN_PUBLIC_KEY_SHA256=$COSIGN_PUBLIC_KEY_SHA256"
  -e DEEPSEEK_API_KEY
)
for key in DOFE_AGENT_DEEPSEEK_MODEL_CANARY_TIMEOUT_MS DEEPSEEK_BASE_URL NODE_EXTRA_CA_CERTS SSL_CERT_FILE HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
  if [ -n "${!key:-}" ]; then DOCKER_ENV+=(-e "$key"); fi
done

CONTAINER_MAY_EXIST=1
docker run --rm --pull=never --name "$CONTAINER_NAME" --entrypoint dofe-agent-daemon \
  "${DOCKER_ENV[@]}" -- "$IMAGE" verify-deepseek-model-canary > "$TEMPORARY" &
DOCKER_PID=$!
DEADLINE=$((SECONDS + HOST_TIMEOUT_SECONDS))
while kill -0 "$DOCKER_PID" 2>/dev/null; do
  if [ "$(wc -c < "$TEMPORARY")" -gt "$MAX_EVIDENCE_BYTES" ]; then
    echo "DeepSeek native-model canary exceeded the evidence size limit." >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "DeepSeek native-model canary exceeded its host-side deadline." >&2
    exit 1
  fi
  sleep 0.2
done
if wait "$DOCKER_PID"; then DOCKER_STATUS=0; else DOCKER_STATUS=$?; fi
DOCKER_PID=""
remove_container
if [ "$DOCKER_STATUS" -ne 0 ]; then
  echo "DeepSeek native-model canary failed for immutable image: $IMAGE" >&2
  exit 1
fi
if [ "$(wc -c < "$TEMPORARY")" -gt "$MAX_EVIDENCE_BYTES" ]; then
  echo "DeepSeek native-model canary exceeded the evidence size limit." >&2
  exit 1
fi
python3 "$REPO_ROOT/deploy/staging/verify-deepseek-model-canary-evidence.py" \
  --evidence "$TEMPORARY" \
  --release-evidence "$RELEASE_EVIDENCE_SNAPSHOT" \
  --image-digest "$IMAGE_DIGEST" \
  --cosign-public-key "$COSIGN_PUBLIC_KEY_SNAPSHOT"
chmod 0444 "$TEMPORARY"
mv -f "$TEMPORARY" "$OUTPUT"
TEMPORARY=""
cleanup
trap - EXIT HUP INT TERM
echo "wrote DeepSeek native-model canary evidence: $OUTPUT"
