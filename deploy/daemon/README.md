# One Runtime Per Container

This deployment model creates one remote daemon and one DofeAgent runtime per container. It deliberately does not combine Codex, Claude Code, OpenClaw, and Hermes credentials in the same process or filesystem.

1. Copy `.env.example` to `.env` and pin the approved installation command for each provider.
2. Copy `runtimes/runtime.env.example` to `runtimes/codex.env`, `runtimes/claude.env`, `runtimes/openclaw.env`, and `runtimes/hermes.env`, then set `DOFE_AGENT_RUNTIME_PROVIDER` in each file to its one permitted provider.
3. Create a distinct daemon token and daemon ID for every file. A token binds to its first registered daemon and cannot claim another container's runtime.
4. Complete each provider's non-interactive authentication in its own named `*-auth` volume before enabling production traffic.
5. Start the selected runtimes with `docker compose --env-file .env -f docker-compose.runtimes.yml up -d`.

The Compose template intentionally has no Docker socket, no host worktree mount, no shared provider-auth volume, and no shared daemon token. If the DofeAgent endpoint uses a private CA, mount only the CA PEM read-only and set `NODE_EXTRA_CA_CERTS` in the corresponding runtime env file.

Codex uses `workspace-write` by default. The daemon no longer turns off provider approvals or sandboxes, and Hermes is invoked without `--yolo`.
