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
      for (const row of getDatabase().prepare(`
        SELECT w.id
        FROM workspace w
        WHERE w.id LIKE ?
          AND NOT EXISTS (
            SELECT 1
            FROM daemon_connection d
            WHERE d.workspace_id = w.id
              AND d.status = 'online'
              AND d.metadata_json->>'managedNode' = 'true'
          )
        ORDER BY w.id
      `).all("sso-team-%")) {
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
