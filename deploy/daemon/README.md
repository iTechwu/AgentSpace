# One Runtime Per Container

This deployment model creates one remote daemon and one DofeAgent runtime per container. It deliberately does not combine Codex, Claude Code, OpenClaw, Hermes, and DeepSeek Harness credentials in the same process or filesystem.

1. Copy `.env.example` to `.env` and pin the approved installation command for each provider.
2. Create a Provider Account for the workspace, with a node-local `file://` `secretRef` or `configRef`. Copy `runtimes/runtime.env.example` to the provider-specific env file (`codex.env`, `claude.env`, `openclaw.env`, `hermes.env`, or `deepseek-harness.env`); set `DOFE_AGENT_RUNTIME_PROVIDER`, the matching `DOFE_AGENT_PROVIDER_ACCOUNT_ID`, and references below that runtime's mounted credential root. DeepSeek Harness can start from `runtimes/deepseek-harness.env.example`.
3. Create a distinct daemon token and daemon ID for every file. A token binds to its first registered daemon and cannot claim another container's runtime.
4. Put each provider's non-interactive authentication files and API keys in that runtime's credential directory before enabling production traffic.
5. Start the selected runtimes with `docker compose --env-file .env -f docker-compose.runtimes.yml up -d`.

The Compose template intentionally has no Docker socket, no host worktree mount, no shared provider-auth volume, and no shared daemon token. If the DofeAgent endpoint uses a private CA, mount only the CA PEM read-only and set `NODE_EXTRA_CA_CERTS` in the corresponding runtime env file.

Codex uses `workspace-write` by default. The daemon no longer turns off provider approvals or sandboxes, and Hermes is invoked without `--yolo`. `DOFE_AGENT_PROVIDER_ACCOUNT_ID` is an account identifier, never a credential: resolve and mount the referenced provider configuration only inside that runtime's isolated auth/config volume.

Each provider credential directory contains a node-local `provider-accounts.json` map. It maps a Provider Account ID to `configRef` and `secretRef`; the daemon accepts only `file://` references beneath `DOFE_AGENT_PROVIDER_CREDENTIAL_ROOT`, copies their `files` entries to that runtime's private provider HOME, and supplies their `environment` entries only to that runtime's process. The secret-derived profile is stored with mode `0700` in that runtime's state volume and is replaced on each daemon start.

A `configRef` / `secretRef` target file looks like this:

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
`https://ixicai.cn/api`, and leave
`MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS` empty so managed runtimes use the public gateway.
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
docker image inspect dofe/agent-runtime-deepseek-harness:latest
```

The DeepSeek wrapper uses `Dockerfile.deepseek-harness-runtime`. It keeps the
exact npm `dsh@0.1.1-rc.2` CLI only for the default-disabled headless fallback;
the JSON-RPC carrier is never sourced from that package. Provide a fixed-tag
production wheel from the fork release and independently recorded wheel,
carrier, and ripgrep digests. Importing verifies the wheel distribution,
version, Linux x86_64 tag, exact carrier set, fixed source commit, and artifact
bytes before atomically writing the Docker context:

```sh
python3 deploy/staging/prepare-deepseek-runtime-bundle.py \
  --wheel /absolute/path/to/deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl \
  --wheel-sha256 <recorded-wheel-sha256> \
  --executable-sha256 <recorded-carrier-sha256> \
  --ripgrep-sha256 <recorded-ripgrep-sha256> \
  --source-commit b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
  --output-dir /absolute/path/to/linux-amd64-bundle
```

Build only from the resulting directory, which contains the two executables and
`provenance.json`:

```sh
DEEPSEEK_HARNESS_RUNTIME_BUNDLE_CONTEXT=/absolute/path/to/linux-amd64-bundle \
DEEPSEEK_RUNTIME_SOURCE_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
DEEPSEEK_RUNTIME_WHEEL_SHA256=<recorded-wheel-sha256> \
DEEPSEEK_JSONRPC_EXECUTABLE_SHA256=<recorded-carrier-sha256> \
DEEPSEEK_JSONRPC_RIPGREP_SHA256=<recorded-ripgrep-sha256> \
DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT=/absolute/path/to/deepseek-release-evidence.json \
MANAGED_RUNTIME_IMAGE_TAG=latest \
  docker compose -f docker-compose.runtimes.yml build runtime-deepseek-harness
```

The staging build script validates the structured provenance before Docker. The
image repeats that verification, copies the repository-approved Cordis config,
checks its fixed digest, bakes a managed-bundle attestation marker, and records
the source tag, source commit, wheel digest, and runtime digests as
`ai.dofe.deepseek-*` image labels. It also exposes the in-image provenance path,
fixed source commit, and wheel digest to the daemon. Managed catalog discovery,
task launch, and provider health all parse that file again and require its exact
schema, source identity, wheel metadata, and carrier/sidecar digests to match the
runtime pins before spawning the carrier. Missing, tampered, or detached
provenance therefore fails closed even when the attestation marker is present.
Standalone runtimes do not set or require these managed-only provenance values.
Use `build-managed-runtime-images.sh` for a releasable local image rather than
the raw Compose command shown above. In addition to bundle preflight and image
build, it runs the image's packaged daemon with
`verify-deepseek-release`, validates the deterministic JSON, and atomically
writes `DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT` before applying the managed-runtime
tag:

```sh
DEEPSEEK_HARNESS_RUNTIME_BUNDLE_CONTEXT=/absolute/path/to/linux-amd64-bundle \
DEEPSEEK_RUNTIME_SOURCE_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e \
DEEPSEEK_RUNTIME_WHEEL_SHA256=<recorded-wheel-sha256> \
DEEPSEEK_JSONRPC_EXECUTABLE_SHA256=<recorded-carrier-sha256> \
DEEPSEEK_JSONRPC_RIPGREP_SHA256=<recorded-ripgrep-sha256> \
DEEPSEEK_RUNTIME_EVIDENCE_OUTPUT=/absolute/path/to/deepseek-release-evidence.json \
MANAGED_RUNTIME_IMAGE_TAG=<release-tag> \
  ./deploy/staging/build-managed-runtime-images.sh deepseek-harness
```

This evidence proves pinned in-image files, exact server identity, NDJSON stdout
purity, and bounded initialize/shutdown. It contains no credential or host path
and is not a model canary or registry attestation. After publishing the wrapper,
run both native models from the immutable registry digest:

```sh
export DEEPSEEK_API_KEY="$(read-test-secret-from-your-secret-store)"
DEEPSEEK_RUNTIME_IMAGE=registry.example/dofe/agent-runtime-deepseek-harness@sha256:<image-digest> \
DEEPSEEK_RUNTIME_IMAGE_REPOSITORY=registry.example/dofe/agent-runtime-deepseek-harness \
DEEPSEEK_RUNTIME_IMAGE_SHA256=<image-digest-without-sha256-prefix> \
DEEPSEEK_RUNTIME_RELEASE_EVIDENCE=/absolute/path/to/deepseek-release-evidence.json \
DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY=/absolute/path/to/deepseek-runtime-cosign.pub \
DEEPSEEK_RUNTIME_COSIGN_PUBLIC_KEY_SHA256=<approved-public-key-sha256> \
DEEPSEEK_MODEL_CANARY_EVIDENCE_OUTPUT=/absolute/path/to/deepseek-model-canary-evidence.json \
  ./deploy/staging/run-deepseek-runtime-canary.sh
```

Before Docker can receive the API key, the runner requires the image repository to
match the separately approved repository and verifies the exact digest-pinned image
with `cosign verify --key` in a scrubbed environment. The public key must be an
absolute, bounded, non-symlink PEM file whose bytes match the separately approved
SHA-256. The runner snapshots that key and the release evidence into a private
directory, then uses the same immutable snapshots for cosign and final evidence
verification. It then uses `--pull=never`,
overrides the managed image's daemon entrypoint, and passes the key to Docker by
environment-variable name, never as an argument.
It applies independent cosign and container deadlines, bounds evidence stdout, and
always force-removes the uniquely named container through a bounded client cleanup
ladder. The container executes one complete pinned JSON-RPC turn for
`deepseek-v4-flash` and `deepseek-v4-pro`; its isolated carrier environment
keeps unrelated provider credentials out. The verifier binds model results and
canonical usage, a bounded-fresh timestamp, the signing public-key digest, and an
official/configured endpoint identity hash to the release evidence and image digest, then atomically
publishes evidence containing no prompt, response, key, or host path. A failed
run preserves the previous valid evidence. Keep the runtime JSON-RPC and Web
canary flags disabled until this real evidence exists.

The dedicated `docker-compose.deepseek-runtime.yml` service constructs its image
as `${DEEPSEEK_RUNTIME_IMAGE_REPOSITORY}@sha256:${DEEPSEEK_RUNTIME_IMAGE_SHA256}`.
The canary runner requires those fields to reconstruct the exact
`DEEPSEEK_RUNTIME_IMAGE`; it has no DeepSeek `build:` or mutable-tag fallback.
Use the controlled deployment entrypoint so the same shell environment completes
signature verification and both model turns before Compose starts the image:

```sh
set -a
. /absolute/path/to/deepseek-release.env
set +a
./deploy/staging/deploy-deepseek-runtime.sh
```

The general `docker-compose.remote-images.yml` remains usable for other
providers without requiring DeepSeek release variables.

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

The dedicated DeepSeek Compose file applies the canary-verified digest directly;
the remote-images Compose file remains provider-generic.
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
