# One Runtime Per Container

This deployment model creates one remote daemon and one DofeAgent runtime per container. It deliberately does not combine Codex, Claude Code, OpenClaw, and Hermes credentials in the same process or filesystem.

1. Copy `.env.example` to `.env` and pin the approved installation command for each provider.
2. Create a Provider Account for the workspace, with a `secretRef` or `configRef` that the target node's secret manager can resolve. Copy `runtimes/runtime.env.example` to `runtimes/codex.env`, `runtimes/claude.env`, `runtimes/openclaw.env`, and `runtimes/hermes.env`; set `DOFE_AGENT_RUNTIME_PROVIDER` and the matching `DOFE_AGENT_PROVIDER_ACCOUNT_ID` in each file.
3. Create a distinct daemon token and daemon ID for every file. A token binds to its first registered daemon and cannot claim another container's runtime.
4. Complete each provider's non-interactive authentication in its own named `*-auth` volume before enabling production traffic.
5. Start the selected runtimes with `docker compose --env-file .env -f docker-compose.runtimes.yml up -d`.

The Compose template intentionally has no Docker socket, no host worktree mount, no shared provider-auth volume, and no shared daemon token. If the DofeAgent endpoint uses a private CA, mount only the CA PEM read-only and set `NODE_EXTRA_CA_CERTS` in the corresponding runtime env file.

Codex uses `workspace-write` by default. The daemon no longer turns off provider approvals or sandboxes, and Hermes is invoked without `--yolo`. `DOFE_AGENT_PROVIDER_ACCOUNT_ID` is an account identifier, never a credential: resolve and mount the referenced provider configuration only inside that runtime's isolated auth/config volume.
