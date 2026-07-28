# Managed-Runtime Staging (Phase 3 E2E)

Run the `verify:managed-runtime-*` release gates end-to-end against the **real**
`models.dofe.ai` service (mounted by nginx at `model.local.dofe.ai/api`).

This directory adds **orchestration + seed tooling + image alignment**. It does
NOT duplicate the models service (that lives in `../models.dofe.ai`) or any
already-deployed AgentSpace stack. Both codebases already implement and align on
the contract; nginx maps `model.local.dofe.ai/api/*` → the models app, so
AgentSpace's gateway URL composition (`{base}/v1`, `{base}/anthropic`,
`{base}/gemini`) is correct as-is.

## What lives here

| File | Purpose |
| --- | --- |
| `build-managed-runtime-images.sh` | Build the 4 runtime images and tag them into the `dofe/agent-runtime-<provider>:<tag>` namespace the daemon pulls. |
| `setup-egress-network.sh` | Create the labelled isolated Docker network (`dofe.managed-egress=restricted`) the daemon + egress gate require. |
| `seed-credential.mjs` | Validate the AgentSpace→models wiring (HMAC + service allowlist + contract) by creating a RuntimeCredential; prints a `STAGING_*` env fragment. |
| `run-gates.sh` | Run the egress + billing release gates with the staging env. |
| `.env.staging.example` | Full env template (models, network, vault, STAGING_* evidence). |

The verify gates themselves are in `deploy/self-hosted/`
(`verify-managed-runtime-egress.mjs`, `verify-managed-runtime-billing.mjs`,
`managed-runtime-release-gates.mjs`) and are reused as-is.

## Prerequisites

1. **Docker** (for image builds, the egress network, and the probe container).
2. **`models.dofe.ai` reachable** at `model.local.dofe.ai/api` (nginx) — OR a
   local instance. A test **tenant + team + billing account (with balance)** must
   exist and its `tenantId` / `teamId` be known. There is **no internal API to
   create tenants/teams** — create them through the models admin flow or models
   DB (see `../models.dofe.ai`). If a models-side seed script is wanted, add it
   to `../models.dofe.ai/scripts/` (the models repo is editable).
3. **AgentSpace running in `remote` mode** (`deploy/self-hosted/`), with its SSO
   workspace bound to the models `teamId`, and `MODELS_INTERNAL_API_SECRET` /
   `MODELS_SERVICE_NAME` matching the models `InternalAuthGuard` allowlist.
4. **Encryption keys** generated:
   ```sh
   openssl rand -base64 32  # DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY
   openssl rand -base64 32  # NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
   ```

## Steps

### 1. Build + tag the managed-runtime images

```sh
MANAGED_RUNTIME_IMAGE_TAG=latest \
  ./deploy/staging/build-managed-runtime-images.sh codex claude
```

The daemon pulls `dofe/agent-runtime-<provider>:<tag>`; the existing
`deploy/daemon/docker-compose.runtimes.yml` builds `dofe-agent-runtime-<p>:local`.
This script builds via that compose and re-tags into the expected namespace.

### 2. Create the isolated egress network

```sh
# Local (models runs as a container on this network; no external egress at all):
STAGING_EGRESS_MODE=internal ./deploy/staging/setup-egress-network.sh

# Deployed models at model.local.dofe.ai (external route + host firewall):
STAGING_EGRESS_MODE=firewall ./deploy/staging/setup-egress-network.sh
```

`internal` mode is fully reproducible locally: the models gateway must be a
container on the network, and `MODELS_GATEWAY_BASE_URL` points at it. Blocked
hosts are unreachable by construction. `firewall` mode keeps external reach and
prints the iptables rules to apply (production should use Kubernetes
NetworkPolicy / a cloud firewall).

### 3. Configure AgentSpace staging env

```sh
cp deploy/staging/.env.staging.example deploy/staging/.env.staging
# edit: models URL/secret, network name, vault keys, STAGING_* (after step 5)
```

### 4. Seed identity

The seed has two halves:

- **models side (prereq)**: ensure a test tenant + team + billing account with
  balance exist (models admin / DB). Note `tenantId`, `teamId`.
- **AgentSpace side**: create a workspace bound to that `teamId`, then create a
  managed runtime through the UI (`/runtimes` → create wizard). Provisioning
  calls `runtimeCredentials.create` on models (HMAC) — if that succeeds, the
  AgentSpace↔models wiring + HMAC + service allowlist are correct. You can
  pre-validate just that wiring + seed a credential out-of-band:
  ```sh
  node --env-file=deploy/staging/.env.staging deploy/staging/seed-credential.mjs \
    --runtime-id runtime-staging-1 --provider codex --model gpt-5
  ```
  It prints `STAGING_RUNTIME_CREDENTIAL_ID` / `STAGING_RUNTIME_ID` to append to
  `.env.staging`.

### 5. Produce the billing evidence (a REAL chat)

The billing gate reconciles one real gateway usage record — it cannot be
synthesized. Run a real task through the provisioned runtime + employee so the
gateway records usage with a `requestId`. Capture that `requestId`
(`x-dofe-request-id` on the gateway response, visible in the daemon's usage
JSONL / models `usage.tenantLogs`) plus the runtime credential id, runtime id,
employee id, conversation id, and model. Put them in `.env.staging` as the
`STAGING_*` values.

### 6. Run the gates

```sh
./deploy/staging/run-gates.sh            # egress + billing
./deploy/staging/run-gates.sh egress     # just egress
```

Evidence JSON is written to `MANAGED_RUNTIME_EVIDENCE_DIR`
(default `artifacts/managed-runtime`, mode `0600`).

## Honest scope notes

- **Provisioning E2E** (create runtime → credential issued → daemon pulls image
  → installs → health check via gateway → ready) is fully exercisable here.
- **Billing reconciliation** requires the real chat from step 5; the gate then
  verifies the models usage log matches the local attribution exactly.
- **Egress isolation** in `internal` mode is a local approximation (no external
  route). True egress enforcement on deployed infra uses NetworkPolicy / cloud
  firewall — the `firewall` mode prints the host iptables equivalent.
- **Tenant/team/billing creation** is a models-admin concern (no internal API).
  Add a models-side seed script to `../models.dofe.ai` if you want it automated.
