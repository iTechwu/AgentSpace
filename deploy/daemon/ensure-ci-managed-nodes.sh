#!/bin/sh
set -eu

: "${MANAGED_NODE_DEPLOY_DIR:?Set MANAGED_NODE_DEPLOY_DIR}"
: "${MANAGED_NODE_SOURCE_DIR:?Set MANAGED_NODE_SOURCE_DIR}"
: "${MANAGED_NODE_WEB_CONTAINER:?Set MANAGED_NODE_WEB_CONTAINER}"
: "${MANAGED_NODE_SERVER_URL:?Set MANAGED_NODE_SERVER_URL}"
: "${MANAGED_NODE_SERVER_HOST:?Set MANAGED_NODE_SERVER_HOST}"
: "${MANAGED_NODE_DOCKER_NETWORK:?Set MANAGED_NODE_DOCKER_NETWORK}"
: "${MANAGED_NODE_POSTGRES_CONTAINER:?Set MANAGED_NODE_POSTGRES_CONTAINER}"
: "${MANAGED_NODE_POSTGRES_USER:?Set MANAGED_NODE_POSTGRES_USER}"
: "${MANAGED_NODE_POSTGRES_DB:?Set MANAGED_NODE_POSTGRES_DB}"
: "${DOFE_SKILL_RUNNER_NODE_IMAGE:?Set an immutable Node.js Skill Runner image}"
: "${DOFE_SKILL_RUNNER_PYTHON_IMAGE:?Set an immutable Python Skill Runner image}"
: "${DOFE_SKILL_RUNNER_BASH_IMAGE:?Set an immutable Bash Skill Runner image}"

upsert_managed_node_env() {
  env_file_path="$1"
  env_key="$2"
  env_value="$3"
  env_tmp="$(mktemp "${env_file_path}.XXXXXX")"
  grep -v "^${env_key}=" "$env_file_path" > "$env_tmp"
  printf '%s=%s\n' "$env_key" "$env_value" >> "$env_tmp"
  chmod 600 "$env_tmp"
  mv "$env_tmp" "$env_file_path"
}

for runner_image in \
  "$DOFE_SKILL_RUNNER_NODE_IMAGE" \
  "$DOFE_SKILL_RUNNER_PYTHON_IMAGE" \
  "$DOFE_SKILL_RUNNER_BASH_IMAGE"
do
  case "$runner_image" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *) printf '%s\n' "Skill Runner images must use repo@sha256:<64 hex> references" >&2; exit 1 ;;
  esac
  runner_digest="${runner_image##*@sha256:}"
  case "$runner_digest" in
    *[!0-9a-fA-F]*) printf '%s\n' "Skill Runner image digests must be hexadecimal" >&2; exit 1 ;;
  esac
  docker pull "$runner_image"
done

case "${DOFE_SKILL_RUNNER_TIMEOUT_MS:-60000}" in
  ''|0|*[!0-9]*) printf '%s\n' "DOFE_SKILL_RUNNER_TIMEOUT_MS must be a positive integer" >&2; exit 1 ;;
esac

state_root="$MANAGED_NODE_DEPLOY_DIR/managed-nodes"
image_tag="${MANAGED_RUNTIME_IMAGE_TAG:-latest}"
node_user="${MANAGED_NODE_USER:-0:0}"
mkdir -p "$state_root"
chmod 700 "$state_root"

# These are private, locally approved wrappers. They are intentionally built
# here rather than pulled from a public registry by a runtime provisioning task.
(
  cd "$MANAGED_NODE_SOURCE_DIR/deploy/daemon"
  MANAGED_RUNTIME_IMAGE_TAG="$image_tag" docker compose \
    -f docker-compose.remote-images.yml \
    build runtime-codex runtime-claude runtime-openclaw runtime-hermes
)

if [ -n "${MANAGED_NODE_WORKSPACE_IDS:-}" ]; then
  workspace_ids="$MANAGED_NODE_WORKSPACE_IDS"
else
  workspace_ids="$(docker exec "$MANAGED_NODE_WEB_CONTAINER" node --experimental-strip-types -e '
    import("./packages/db/src/database.ts").then(({ getDatabase }) => {
      const query = getDatabase().prepare(`
        SELECT w.id
        FROM workspace w
        WHERE w.id LIKE ?
          AND NOT EXISTS (
            SELECT 1
            FROM daemon_connection d
            WHERE d.workspace_id = w.id
              AND d.status = ?
              AND d.metadata_json->>? = ?
          )
        ORDER BY w.id
      `);
      for (const row of query.all("sso-team-%", "online", "managedNode", "true")) {
        console.log(row.id);
      }
    });
  ')"
fi

for workspace_id in $workspace_ids; do
  case "$workspace_id" in
    sso-team-*) ;;
    *)
      echo "Refusing unmanaged workspace id: $workspace_id" >&2
      exit 2
      ;;
  esac

  suffix="$(printf '%s' "$workspace_id" | cksum | awk '{print $1}')"
  daemon_id="ci-managed-node-$suffix"
  project="dofe-agentspace-managed-node-$suffix"
  node_dir="$state_root/$suffix"
  env_file="$node_dir/node.env"
  state_dir="$node_dir/state"
  mkdir -p "$state_dir"
  chmod 700 "$node_dir" "$state_dir"

  if [ ! -s "$env_file" ]; then
    token="$(docker exec -e DOFE_AGENT_MANAGED_NODE_WORKSPACE_ID="$workspace_id" "$MANAGED_NODE_WEB_CONTAINER" node --experimental-strip-types -e '
      import("./packages/db/src/daemon-tokens.ts").then(({ createManagedDaemonBootstrapTokenSync }) => {
        const workspaceId = process.env.DOFE_AGENT_MANAGED_NODE_WORKSPACE_ID;
        if (!workspaceId) throw new Error("missing workspace id");
        process.stdout.write(createManagedDaemonBootstrapTokenSync({
          workspaceId,
          label: "CI managed node",
          createdBy: "jenkins-ci",
        }).token);
      });
    ')"
    [ -n "$token" ]
    tmp_env="$(mktemp "$node_dir/node.env.XXXXXX")"
    {
      printf '%s\n' "DOFE_AGENT_SERVER_URL=$MANAGED_NODE_SERVER_URL"
      printf '%s\n' "DOFE_AGENT_DAEMON_TOKEN=$token"
      printf '%s\n' "DOFE_AGENT_DAEMON_ID=$daemon_id"
      printf '%s\n' "DOFE_AGENT_DEVICE_NAME=CI managed execution node ($workspace_id)"
      printf '%s\n' "DOFE_AGENT_RUNTIME_NAME=CI managed execution node"
      printf '%s\n' "MANAGED_NODE_STATE_DIR=$state_dir"
      printf '%s\n' "MANAGED_NODE_USER=$node_user"
      printf '%s\n' "MANAGED_RUNTIME_DOCKER_NETWORK=$MANAGED_NODE_DOCKER_NETWORK"
      printf '%s\n' "MANAGED_RUNTIME_IMAGE_TAG=$image_tag"
      if [ -n "${MANAGED_NODE_TLS_CA_PATH:-}" ]; then
        printf '%s\n' "MANAGED_NODE_TLS_CA_PATH=$MANAGED_NODE_TLS_CA_PATH"
      fi
    } > "$tmp_env"
    mv "$tmp_env" "$env_file"
    chmod 600 "$env_file"
  fi

  upsert_managed_node_env "$env_file" "DOFE_SKILL_RUNNER_NODE_IMAGE" "$DOFE_SKILL_RUNNER_NODE_IMAGE"
  upsert_managed_node_env "$env_file" "DOFE_SKILL_RUNNER_PYTHON_IMAGE" "$DOFE_SKILL_RUNNER_PYTHON_IMAGE"
  upsert_managed_node_env "$env_file" "DOFE_SKILL_RUNNER_BASH_IMAGE" "$DOFE_SKILL_RUNNER_BASH_IMAGE"
  upsert_managed_node_env "$env_file" "DOFE_SKILL_RUNNER_TIMEOUT_MS" "${DOFE_SKILL_RUNNER_TIMEOUT_MS:-60000}"

  MANAGED_NODE_ENV_FILE="$env_file" MANAGED_NODE_SERVER_HOST="$MANAGED_NODE_SERVER_HOST" \
    docker compose --project-name "$project" --env-file "$env_file" \
      -f "$MANAGED_NODE_SOURCE_DIR/deploy/daemon/docker-compose.managed-node.yml" up --build -d
  node_id="$(docker compose --project-name "$project" --env-file "$env_file" -f "$MANAGED_NODE_SOURCE_DIR/deploy/daemon/docker-compose.managed-node.yml" ps -q managed-node)"
  [ -n "$node_id" ]

  attempts=0
  until [ "$(docker inspect "$node_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" = healthy ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 48 ]; then
      docker logs --tail 100 "$node_id"
      exit 1
    fi
    sleep 5
  done

  attempts=0
  until docker exec "$MANAGED_NODE_POSTGRES_CONTAINER" psql -U "$MANAGED_NODE_POSTGRES_USER" -d "$MANAGED_NODE_POSTGRES_DB" -Atqc "SELECT status FROM daemon_connection WHERE daemon_key = '$daemon_id'" | grep -qx online; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 24 ]; then
      docker logs --tail 100 "$node_id"
      exit 1
    fi
    sleep 5
  done
done
