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
