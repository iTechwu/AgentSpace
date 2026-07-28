# Self-hosted Docker Stack

This Compose stack starts the Next.js web/API service, a database initializer, and two local execution daemons: Claude Code and Codex. PostgreSQL is external to this stack and must be available before startup. The Claude daemon owns the Feishu WebSocket supervisor. It automatically discovers active Feishu Bot bindings, so do not also start `deploy/feishu-worker` for this stack.

## Start

```bash
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
# Set the reachable external PostgreSQL URLs and every replace_with_* value.
# Then pin the approved provider versions.
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml up --build -d
```

The first run initializes the external database schema before the web service and daemons start. The `runtime-maintenance` service periodically resumes durable provisioning and cleanup work through the authenticated internal cron route. Inspect all long-running components with:

```bash
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml ps
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml logs -f daemon-claude daemon-codex web
```

## Managed Runtime network gate

Remote managed nodes require `MANAGED_RUNTIME_DOCKER_NETWORK`. Create that network with infrastructure-level DNS and egress policy that permits the models gateway but denies direct Provider endpoints. The daemon rejects missing configuration and Docker's permissive `host`, `bridge`, and `default` networks.

Label the network after the infrastructure policy has been applied. The label is an attestation marker, not the policy itself:

```bash
docker network create --label dofe.managed-egress=restricted dofe-models-egress
```

Run the release gate from each managed node:

```bash
npm run verify:managed-runtime-egress
```

The check must reach `MODELS_GATEWAY_BASE_URL`; every domain in `MANAGED_RUNTIME_BLOCKED_EGRESS_URLS`, raw IP in `MANAGED_RUNTIME_BLOCKED_EGRESS_IPS`, and proxy in `MANAGED_RUNTIME_BLOCKED_PROXY_URLS` must be unreachable. It also rejects proxy variables baked into the Runtime image and validates `MANAGED_RUNTIME_NETWORK_POLICY_LABEL`. Results are written as JSON below `MANAGED_RUNTIME_EVIDENCE_DIR`.

## Managed Runtime billing gate

In staging, use the approved Runtime image and Runtime Key to make one real model request. Record its tenant, Runtime Credential, Runtime, AI employee, conversation, gateway request ID, model, and start time in the corresponding `STAGING_*` variables in the repository root `.env`. These values are request-scoped release evidence, not application runtime configuration; replace them for each release candidate. After models has finalized the charge, run:

```bash
npm run verify:managed-runtime-billing
```

The gate queries the models internal tenant usage API and requires an exact attribution match, a terminal billing status, a valid cost, and a currency. To run both release gates in sequence:

```bash
npm run verify:managed-runtime-release
```

Keep production in `local` mode until both commands pass on every managed node and their JSON evidence has been retained with the release record.

## Provider authentication

Each daemon mounts a distinct read-only credential directory and builds a private provider profile below its own daemon-state volume. Create `config.json` and/or `secret.json` in the directories configured by `DOFE_AGENT_CLAUDE_PROVIDER_CREDENTIAL_DIR` and `DOFE_AGENT_CODEX_PROVIDER_CREDENTIAL_DIR`. The corresponding `file://` references in `.env` are passed through the Provider Account approval flow and resolved only within that daemon's container.

```json
{
  "version": 1,
  "environment": {
    "ANTHROPIC_BASE_URL": "https://provider-gateway.example",
    "ANTHROPIC_API_KEY": "replace-with-node-local-secret"
  },
  "files": {
    ".claude.json": "{...}"
  }
}
```

Use `config.json` for non-sensitive endpoint/model settings and `secret.json` for API keys or provider auth files. `secret.json` overrides duplicate entries in `config.json`. Do not use `docker compose exec ... login` for this deployment model: that writes to the service home volume, whereas the daemon intentionally runs the provider with its account-specific profile.

`daemon-claude` is deliberately the only service with `DOFE_AGENT_MANAGE_FEISHU_WORKER=true`. If you add more daemon services, leave that setting false unless you move Feishu ownership to the new service. This prevents duplicate long connections and duplicate event delivery.

## Feishu

The Feishu credential encryption key must exactly match the key used when credentials were saved. The active Feishu Bot bindings live in PostgreSQL; adding, rotating, or disabling a binding requires no Compose command or worker restart. The managed supervisor reconciles bindings every 15 seconds and drains outbound replies every 2 seconds.

## Upgrade

```bash
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml up --build -d
```

The attachment, daemon state, and provider-home volumes persist across upgrades. Database backups and lifecycle remain with the external PostgreSQL service.
