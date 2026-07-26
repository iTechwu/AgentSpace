# Self-hosted Docker Stack

This Compose stack starts the Next.js web/API service, a database initializer, and two local execution daemons: Claude Code and Codex. PostgreSQL is external to this stack and must be available before startup. The Claude daemon owns the Feishu WebSocket supervisor. It automatically discovers active Feishu Bot bindings, so do not also start `deploy/feishu-worker` for this stack.

## Start

```bash
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
# Set the reachable external PostgreSQL URLs and every replace_with_* value.
# Then pin the approved provider versions.
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml up --build -d
```

The first run initializes the external database schema before the web service and daemons start. Inspect all long-running components with:

```bash
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml ps
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml logs -f daemon-claude daemon-codex web
```

## Provider authentication

Each daemon owns a separate persistent home volume. Authenticate Claude Code in `daemon-claude` and Codex in `daemon-codex` using the provider-approved flow for your organization. Do not share provider credentials between the two services.

```bash
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml exec daemon-claude claude login
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml exec daemon-codex codex login
```

`daemon-claude` is deliberately the only service with `DOFE_AGENT_MANAGE_FEISHU_WORKER=true`. If you add more daemon services, leave that setting false unless you move Feishu ownership to the new service. This prevents duplicate long connections and duplicate event delivery.

## Feishu

The Feishu credential encryption key must exactly match the key used when credentials were saved. The active Feishu Bot bindings live in PostgreSQL; adding, rotating, or disabling a binding requires no Compose command or worker restart. The managed supervisor reconciles bindings every 15 seconds and drains outbound replies every 2 seconds.

## Upgrade

```bash
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/docker-compose.yml up --build -d
```

The attachment, daemon state, and provider-home volumes persist across upgrades. Database backups and lifecycle remain with the external PostgreSQL service.
