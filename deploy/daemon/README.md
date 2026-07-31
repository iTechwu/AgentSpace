# One Runtime Per Container

This deployment model creates one remote daemon and one DofeAgent runtime per container. It deliberately does not combine Codex, Claude Code, OpenClaw, and Hermes credentials in the same process or filesystem.

1. Copy `.env.example` to `.env` and pin the approved installation command for each provider.
2. Create a Provider Account for the workspace, with a node-local `file://` `secretRef` or `configRef`. Copy `runtimes/runtime.env.example` to `runtimes/codex.env`, `runtimes/claude.env`, `runtimes/openclaw.env`, and `runtimes/hermes.env`; set `DOFE_AGENT_RUNTIME_PROVIDER`, the matching `DOFE_AGENT_PROVIDER_ACCOUNT_ID`, and references below that runtime's mounted credential root.
3. Create a distinct daemon token and daemon ID for every file. A token binds to its first registered daemon and cannot claim another container's runtime.
4. Put each provider's non-interactive authentication files and API keys in that runtime's credential directory before enabling production traffic.
5. Start the selected runtimes with `docker compose --env-file .env -f docker-compose.runtimes.yml up -d`.

The Compose template intentionally has no Docker socket, no host worktree mount, no shared provider-auth volume, and no shared daemon token. If the DofeAgent endpoint uses a private CA, mount only the CA PEM read-only and set `NODE_EXTRA_CA_CERTS` in the corresponding runtime env file.

Codex uses `workspace-write` by default. The daemon no longer turns off provider approvals or sandboxes, and Hermes is invoked without `--yolo`. `DOFE_AGENT_PROVIDER_ACCOUNT_ID` is an account identifier, never a credential: resolve and mount the referenced provider configuration only inside that runtime's isolated auth/config volume.

Each provider credential directory contains a node-local `provider-accounts.json` map. It maps a Provider Account ID to `configRef` and `secretRef`; the daemon accepts only `file://` references beneath `DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT`, copies their `files` entries to that runtime's private provider HOME, and supplies their `environment` entries only to that runtime's process. The secret-derived profile is stored with mode `0700` in that runtime's state volume and is replaced on each daemon start.

## Managed execution node

`docker-compose.managed-node.yml` is the separate deployment mode used by the
managed-runtime provisioning workflow. It runs one provider-neutral daemon,
mounts the Docker socket, reuses an approved local `dofe/agent-runtime-*` image
when present, and pulls the image only when it is missing. Do not run one
managed-node container per provider.

Copy `managed-node.env.example` to `.env.managed-node`, set a newly-created
daemon token and an absolute `MANAGED_NODE_STATE_DIR`, then start it with:

```sh
docker compose \
  --env-file deploy/daemon/.env.managed-node \
  -f deploy/daemon/docker-compose.managed-node.yml \
  up -d --build
```

The state directory is deliberately bind-mounted at the same absolute path on
the host and in the daemon container. Provider containers are siblings created
through the host Docker socket, so their credential and workspace bind mounts
must resolve to host-visible paths. `MANAGED_NODE_USER=0:0` is suitable for a
local Docker Desktop test; production Linux hosts should instead grant the
container user access to the Docker socket by group id.

When `DOFE_AGENT_SERVER_URL` uses a private TLS certificate, set
`MANAGED_NODE_TLS_CA_PATH` to the absolute host path of the signing CA. The
compose deployment mounts that CA read-only and sets Node's
`NODE_EXTRA_CA_CERTS`; certificate verification remains enabled.

Provider containers are separate Docker siblings, so their model-gateway
connectivity is configured independently. For a local endpoint such as
`https://model.local.dofe.ai/api`, set
`MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS=model.local.dofe.ai:host-gateway` and set
`MANAGED_RUNTIME_TLS_CA_PATH` to the absolute host path of its signing CA.
The managed node passes the host mapping, a read-only CA mount, and
`NODE_EXTRA_CA_CERTS` to both provisioning health checks and provider
launchers. Leave both values empty for ordinary public endpoints.

### Build managed runtime images

Before creating a managed runtime, build its approved wrapper image on the
same Docker host that runs the managed node. The image reference is always
`dofe/agent-runtime-<provider>:<tag>`; use the same
`MANAGED_RUNTIME_IMAGE_TAG` value in the control plane, `.env.managed-node`,
and the build command.

```sh
cd deploy/daemon
MANAGED_RUNTIME_IMAGE_TAG=latest \
  docker compose -f docker-compose.remote-images.yml build runtime-codex runtime-claude

docker image inspect dofe/agent-runtime-codex:latest
docker image inspect dofe/agent-runtime-claude:latest
```

For the local Docker Desktop managed node, select the Mac-published provider
images explicitly. The current managed-node compose service runs `linux/amd64`,
so these images must keep that platform even when they are built on Apple
Silicon:

```sh
CODEX_PROVIDER_BASE_IMAGE=uhub.service.ucloud.cn/techwu/codex-cli:0.145.0.mac \
CLAUDE_PROVIDER_BASE_IMAGE=uhub.service.ucloud.cn/techwu/claude-code-cli:2.1.218.mac \
MANAGED_RUNTIME_IMAGE_TAG=latest \
  docker compose -f docker-compose.remote-images.yml build runtime-codex runtime-claude
```

The remote-images Compose file now applies this canonical image name directly.
Do not pre-pull only the provider base images: they do not include the
`dofe-agent-daemon` runtime wrapper required by managed provisioning.

### CI multi-workspace managed nodes

`ensure-ci-managed-nodes.sh` is the CI-host reconciliation entry point for
remote mode. It builds the approved wrapper images locally, then creates one
managed-node container per `sso-team-*` workspace. Every container receives a
distinct managed-node bootstrap token and state directory, preserving the
workspace binding enforced by daemon registration and task APIs. Set its
required `MANAGED_NODE_*` variables from protected CI configuration; do not
replace this with a cross-workspace daemon token.

```json
{
  "version": 1,
  "environment": {
    "ANTHROPIC_BASE_URL": "https://provider-gateway.example",
    "ANTHROPIC_API_KEY": "node-local-secret"
  },
  "files": {
    ".config/openclaw/auth-profiles.json": "{...}"
  }
}
```

Put non-sensitive endpoint/model settings in `config.json`; put API keys and provider auth files in `secret.json`. Their contents are merged at runtime, with `secret.json` taking precedence. Add an account map such as `{ "accounts": { "provider-account_xxx": { "configRef": "file:///run/dofe-agent-provider/config.json", "secretRef": "file:///run/dofe-agent-provider/secret.json" } } }`. The credential directory is mounted read-only into exactly one runtime container at `/run/dofe-agent-provider`.
