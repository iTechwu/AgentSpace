# Feishu Smoke

This folder is an isolated throwaway smoke harness for Feishu OpenAPI evidence. It supports the data-plane checks from TODO119 and the final evidence gate for TODO120. It does not participate in DofeAgent runtime behavior.

Run dry-run checks without credentials:

```bash
npm run smoke:feishu
```

Dry-run mode does not call Feishu. It validates SDK import/construction, local event dispatch, challenge response, and DofeAgent request builders for IM, Docs, Sheets, and Base/Bitable. Its JSON summary marks live checks as skipped and `strictLiveSatisfied=false`; only `--live --strict-live` can produce live smoke evidence.

Run DofeAgent-side Feishu integration tests with `DOFE_AGENT_TEST_DATABASE_URL` set to an isolated PostgreSQL database. The test runner refuses application databases unless an explicit override is supplied.

Generate the DofeAgent-side live smoke plan before filling credentials:

```bash
npm run cli -- integrations feishu smoke-plan --workspace-id default --app-url https://dofe-agent.example.com
```

The smoke plan checks local DofeAgent readiness first, then prints readable blockers, next actions, and the key Feishu Open Platform / smoke / evidence commands. Append `--json` when automation needs the full machine-readable `appSetup`, final `evidenceGates`, env template path, strict live smoke command, and redacted evidence path. `appSetup` includes the DofeAgent callback URL status, required events, bot scopes, and Docs/Sheets/Base scopes without external chat/user/resource tokens. OpenAPI strict-live evidence and bot-added payload evidence are final-gate artifacts only for 24 hours after their `generatedAt`; bot-added payload verification also requires the Feishu callback `create_time` / `createTime` itself to be within 24 hours, so regenerate from a fresh bot-added callback if final DofeAgent evidence will run later. The final DofeAgent evidence gate also only counts local DB evidence rows from the last 24 hours, and `evidenceGates` includes `fresh_24h_dofe-agent_local_evidence_rows` as a reminder to rerun the native bot, guest-policy, data-plane, worker, and failure smoke steps if those local rows are older. Disabled or archived Feishu bot bindings are treated as unavailable for live smoke setup and final evidence, even if they still have historical local evidence.

Create the DofeAgent-side integration from settings or the CLI after creating the self-built app in Feishu Open Platform. For CLI setup, make sure DofeAgent has a base64-encoded 32-byte credential encryption key, then prepare `scripts/feishu/.env` from the checked-in template, fill the app credentials, and let `create` read that file. The smoke plan includes the same env preparation command so a first-time setup can proceed from the checklist without inventing paths. The CLI stores credentials encrypted and prints only redacted setup metadata plus next commands:

```bash
export DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
test -f scripts/feishu/.env || cp scripts/feishu/env.example scripts/feishu/.env
dofe-agent integrations feishu create --workspace-id default --name Feishu --transport http_webhook --app-url https://dofe-agent.example.com --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --verification-token-env FEISHU_VERIFICATION_TOKEN --encrypt-key-env FEISHU_ENCRYPT_KEY --json
```

The create result includes `openPlatformSetup` with the developer console URL, custom-app setup steps, workspace callback URL, required events, credential fields, bot scopes, and Docs/Sheets/Base scopes to copy into Feishu Open Platform. It also includes copyable `nextCommands` for health-check, smoke-plan, `smoke-env`, `--check-env`, strict live smoke, OpenAPI evidence verification, bot-added payload verification, final DofeAgent evidence verification, second agent-bot binding, and the required chat/user/resource bindings. `bind-agent-bot` results and the Settings / Agent Settings setup guides include the agent-scoped health/readiness, policy, agent-channel-access no-reply smoke, smoke, evidence, channel-binding, bot-added payload verification, and second-bot commands as well. Generated binding commands use shell-safe `CHANGE_ME_*` placeholders, and binding commands reject unfilled placeholders before writing DofeAgent state. If required env values, template placeholder values, or the DofeAgent credential encryption key are missing or invalid, CLI create returns a structured `{ "ok": false, "errorCode": "...", "nextStep": "..." }` response instead of printing raw secrets or low-level encryption errors.

For TODO120 native agent bot smoke, prepare two disposable Feishu apps/bots, for example Codex Bot and HermesAgent Bot. Bind the first bot with `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, then bind the second app to another DofeAgent agent with the secondary env names from `scripts/feishu/env.example`:

```bash
dofe-agent integrations feishu bind-agent-bot --workspace-id default --agent CHANGE_ME_SECOND_AGENT_NAME --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --json
```

The smoke plan includes this second-bot command before the live same-group reuse and thread-collaboration checks. Those checks are not meaningful until both agent-scoped bot bindings exist and the second bot is Phase 6-ready: active, bound to a different DofeAgent agent, using a different Feishu app id, configured with credentials and bot scopes, health-checked, and free of unresolved outbox failures. The smoke-plan anchor for bot/data-plane/worker readiness, callback URLs, smoke-env, binding commands, failure smoke, and final evidence must also be an active agent-scoped Feishu bot binding; active workspace-level Feishu records are reported as `active_agent_bot_integration_missing`, and a selected workspace-level `--integration` is reported as `selected_integration_not_agent_bot`. The final DofeAgent `--require all` evidence step is also blocked until two Phase 6-ready agent bot bindings exist, so a single-bot OpenAPI/data-plane smoke cannot be mistaken for TODO120 native completion.

Bind the DofeAgent-side Feishu prerequisites before running live smoke. The settings page shows unbound chat/user suggestions from redacted inbound events, and when `DOFE_AGENT_APP_URL` / `NEXT_PUBLIC_DOFE_AGENT_APP_URL` / `NEXT_PUBLIC_APP_URL` is configured, unbound Feishu chat/user notices include a direct link back to the matching workspace integrations binding panel. The CLI outputs below redact external ids in their results:

```bash
dofe-agent integrations feishu bind-channel --workspace-id default --integration feishu-1 --channel CHANGE_ME_DOFE_AGENT_CHANNEL --chat-id CHANGE_ME_FEISHU_CHAT_ID --json
dofe-agent integrations feishu bind-user --workspace-id default --integration feishu-1 --user-id CHANGE_ME_DOFE_AGENT_USER_ID --open-id CHANGE_ME_FEISHU_OPEN_ID --json
dofe-agent integrations feishu bind-resource --workspace-id default --integration feishu-1 --type doc --resource CHANGE_ME_FEISHU_DOC_URL_OR_TOKEN --dofe-agent-type channel_document --channel CHANGE_ME_DOFE_AGENT_CHANNEL --allow-write --json
dofe-agent integrations feishu bind-resource --workspace-id default --integration feishu-1 --type sheet --resource CHANGE_ME_FEISHU_SHEET_URL_OR_TOKEN --dofe-agent-type data_table --channel CHANGE_ME_DOFE_AGENT_CHANNEL --allow-write --json
dofe-agent integrations feishu bind-resource --workspace-id default --integration feishu-1 --type base_table --resource CHANGE_ME_FEISHU_BASE_TABLE_URL_WITH_APP_TOKEN --dofe-agent-type data_table --channel CHANGE_ME_DOFE_AGENT_CHANNEL --allow-write --json
```

`bind-user` and the settings user-binding form refuse a Feishu Open ID that is already bound to another DofeAgent user in the same integration; have an admin review or revoke the existing binding before retrying.
`bind-channel` and the settings channel-mapping form similarly refuse a Feishu chat that is already mapped to another DofeAgent channel in the same integration.
`bind-resource` and the settings resource-binding form reuse the existing DofeAgent target for the same Feishu resource, and reject attempts to move an active binding to a different channel document or data table without first archiving the old binding.
Doc resource binding accepts Docx URLs/tokens, Wiki node URLs, and legacy `/docs/<token>` links, preserving the Doc/Wiki type for metadata refresh after binding; Sheet and Base bindings should use the generated placeholders above as the expected URL/token shape.

Then verify local readiness before sending live Feishu messages or mutating smoke resources:

```bash
dofe-agent integrations feishu health-check --workspace-id default --integration feishu-1 --strict --json
dofe-agent integrations feishu readiness --workspace-id default --integration feishu-1 --strict --require bot --json
dofe-agent integrations feishu readiness --workspace-id default --integration feishu-1 --strict --require data-plane --json
```

`health-check --strict` requires DofeAgent to verify the Feishu app scopes automatically. Missing scopes, authorization failures, or scope APIs that require manual review are reported as degraded with sanitized diagnostics; confirm the Open Platform scopes and rerun health-check before live data-plane smoke.

After readiness passes, you can verify DofeAgent-governed data-plane operation runs without printing resource tokens. Read operations call Feishu OpenAPI with the saved integration credentials; write operations only create a pending DofeAgent operation run and still require approval before any Feishu write call:

```bash
dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation read-doc --resource CHANGE_ME_FEISHU_DOC_URL_OR_TOKEN --json
dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation plan-doc-append --resource CHANGE_ME_FEISHU_DOC_URL_OR_TOKEN --parent-block-id CHANGE_ME_DOC_BLOCK_ID --blocks-json '[{"block_type":2,"text":{"elements":[{"text_run":{"content":"DofeAgent smoke"}}]}}]' --approval-agent CHANGE_ME_AGENT_NAME --approval-channel CHANGE_ME_DOFE_AGENT_CHANNEL --json
dofe-agent integrations feishu review-data-operation --workspace-id default --approval-id CHANGE_ME_FEISHU_APPROVAL_ID --decision approved --json
dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation read-sheet --resource CHANGE_ME_FEISHU_SHEET_URL_OR_TOKEN --range Sheet1!A1:C5 --json
dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation query-base --resource CHANGE_ME_FEISHU_BASE_TABLE_ID --app-token CHANGE_ME_FEISHU_BASE_APP_TOKEN --json
dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation plan-sheet-write --resource CHANGE_ME_FEISHU_SHEET_URL_OR_TOKEN --range Sheet1!A1:B1 --values-json '[[\"DofeAgent smoke\"]]' --approval-agent CHANGE_ME_AGENT_NAME --approval-channel CHANGE_ME_DOFE_AGENT_CHANNEL --json
dofe-agent integrations feishu review-data-operation --workspace-id default --approval-id CHANGE_ME_FEISHU_APPROVAL_ID --decision approved --json
dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation plan-base-update --resource CHANGE_ME_FEISHU_BASE_TABLE_ID --app-token CHANGE_ME_FEISHU_BASE_APP_TOKEN --record-id CHANGE_ME_FEISHU_BASE_RECORD_ID --fields-json '{\"Status\":\"Done\"}' --approval-agent CHANGE_ME_AGENT_NAME --approval-channel CHANGE_ME_DOFE_AGENT_CHANNEL --json
dofe-agent integrations feishu review-data-operation --workspace-id default --approval-id CHANGE_ME_FEISHU_APPROVAL_ID --decision approved --json
```

Doc write planning supports `plan-doc-create`, `plan-doc-update`, and `plan-doc-append`; without `--approval-agent` / `--approval-channel` these only create a pending DofeAgent operation run. With both flags, the command also creates the normal `external_data_operation` approval item and returns a safe `approvalId`; approve it from the DofeAgent approval queue or pass that id to `review-data-operation` to execute the same payload-hash-checked write path from CLI. The CLI result reports run id/status and redacted metadata, not Doc block contents.

Data-operation commands reject unfilled `CHANGE_ME_*` placeholders before reading saved integration state, resolving resources, creating Feishu clients, or planning writes. The structured error names only the field path that still needs a real value.

For Agent-triggered Docs/Sheets/Base reads through the runtime `lark-cli` capability, DofeAgent only records evidence when the Agent writes a safe read result manifest under its task workdir:

```json
{
  "kind": "dofe-agent.feishu.lark-cli.result",
  "schemaVersion": 1,
  "ok": true,
  "operationType": "docs.read_document",
  "providerResourceType": "doc",
  "providerResourceToken": "CHANGE_ME_FEISHU_DOC_TOKEN",
  "metrics": {
    "requestCount": 1
  },
  "data": {
    "documentId": "CHANGE_ME_FEISHU_DOC_TOKEN"
  }
}
```

Save that file as `runtime-output/feishu-data-operation-result.json`. The daemon accepts only read manifests whose resource token matches the current channel's active DofeAgent Feishu resource grants, converts raw provider ids to short references, and records the run as `actorType=agent` data-plane evidence. Do not put Doc body text, Sheet cell values, Base record fields, or raw provider responses in this file. Write manifests are ignored here; Feishu writes must still go through DofeAgent approval and payload-hash governance.

For Agent-triggered write requests, use the runtime output approval command instead of running a Feishu write directly:

```bash
dofe-agent output feishu data-operation-approval --operation sheets.update_range --type sheet --resource CHANGE_ME_BOUND_SHEET_TOKEN --range Sheet1!A1:B1 --values-json '[["DofeAgent smoke"]]' --preview "Update smoke range"
dofe-agent output feishu data-operation-approval --operation base.mutate_records --type base_table --resource CHANGE_ME_BOUND_BASE_TABLE_ID --record-id CHANGE_ME_FEISHU_BASE_RECORD_ID --fields-json '{"Status":"Done"}' --preview "Update smoke record"
```

The daemon turns those manifests into normal DofeAgent `external_data_operation` approval requests for the current channel's writable Feishu bindings. Approval execution still uses the existing payload-hash-checked Feishu write path.

Run live checks against a Feishu/Lark self-built app:

```bash
dofe-agent integrations feishu smoke-env --workspace-id default --integration feishu-1 --app-url https://dofe-agent.example.com > scripts/feishu/.env
npm run smoke:feishu -- --env-file scripts/feishu/.env --check-env --json --require-todo120-native
npm run smoke:feishu -- --env-file scripts/feishu/.env --live
```

`smoke-env` fills the DofeAgent callback URL from the workspace/integration id, emits the saved optional tenant key when present, and leaves app secrets, verification token, optional second-agent bot credentials, chat ids, and resource tokens as placeholders. If you prepare `scripts/feishu/.env` by hand, only uncomment `FEISHU_TENANT_KEY` when the same tenant key is saved on the DofeAgent integration. `--check-env` performs a no-network readiness check for the strict live smoke env and exits non-zero until required app, DofeAgent Feishu callback route, IM, Docs, Sheets, and Base values are present, well formed, and no longer template placeholders such as `CHANGE_ME_*`, `REPLACE_ME_*`, `xxx`, or `example.com`. The JSON output also includes `todo120NativeSmoke`, which reports whether `FEISHU_SECOND_AGENT_APP_ID` and `FEISHU_SECOND_AGENT_APP_SECRET` are configured for TODO120's required two-bot native multi-agent smoke; final Phase 6 evidence requires the strict-live artifact to include `todo120NativeSmoke.requiredForCommand=true` and `ready=true`. The callback URL must point at `/api/integrations/feishu/events` with `workspaceId` and `integrationId` query values. Non-strict live mode can skip checks whose credentials or resource tokens are missing; `--live --strict-live` fails before network calls unless every required env is ready. A complete live run needs the DofeAgent callback URL, verification token, a bot chat id, plus authorized Docx, Sheet, and Base/Bitable resources. The Docx append check mutates a disposable parent block configured by `FEISHU_SMOKE_DOC_PARENT_BLOCK_ID` and `FEISHU_SMOKE_DOC_APPEND_BLOCKS_JSON`.

For TODO120 Phase 6, add `--require-todo120-native` to `--check-env` and strict live commands. With that flag, missing or placeholder second-agent bot env fails before any Feishu network call, and `FEISHU_SECOND_AGENT_APP_ID` / `FEISHU_SECOND_AGENT_APP_SECRET` must differ from the primary app credentials. The evidence artifact stores only safe TODO120 readiness booleans/counts plus app/tenant hashes, and both `npm run smoke:feishu -- --verify-evidence ...` and `dofe-agent integrations feishu evidence --require all --openapi-evidence ...` reject artifacts that were not generated with TODO120 native smoke required, do not match the scoped DofeAgent Feishu integration, or contain a tenant hash when the scoped integration has no saved tenant key. This prevents a single-bot, unrelated-app, or unbound-tenant OpenAPI smoke from being mistaken for native multi-agent completion.

When collecting real bot-added callback samples from disposable Feishu tenant/apps, verify the payload shape offline before treating it as Phase 6 evidence:

```bash
npm run smoke:feishu -- --verify-bot-added-payload runtime-output/feishu-smoke/bot-added-callback.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --json
```

The verifier does not call Feishu or DofeAgent. It reuses DofeAgent's bot-added event detector and chat descriptor resolver, then prints and writes only event type, field source, redacted chat/event references, app/tenant hashes, payload hashes, lengths, and booleans. The safe artifact at `runtime-output/feishu-smoke/bot-added-payload-evidence.json` is consumed by the final DofeAgent `--require all` evidence gate, which matches the artifact's app hash and configured tenant hash back to the scoped DofeAgent Feishu integration; if the scoped integration has no saved tenant key, an artifact that carries a tenant hash is rejected as unbound to DofeAgent. `smoke-plan` includes this command as the `verify_real_bot_added_payload_sample` checklist step, and Settings / Agent Settings show the same command in the setup guide. It exits non-zero if the sample is not recognized as `im.chat.member.bot.added_v1` or if no chat descriptor can be resolved, and failed verification does not overwrite an existing bot-added payload evidence artifact. Do not commit the raw callback file; keep it under `runtime-output/` or another local scratch path.

If `smoke-env` cannot find a usable DofeAgent Feishu integration, app id, or public DofeAgent URL, text mode exits non-zero and prints no env template to stdout, so shell redirection does not overwrite an existing `scripts/feishu/.env` with an unusable file.

Malformed env files or JSON env values return structured `{"ok":false,"errorCode":"..."}` diagnostics in `--json` mode. The diagnostics name the env key and reason without printing app secrets, callback URLs, chat ids, resource tokens, or write values.

Use the strict gate when you want the command itself to prove the isolated OpenAPI live smoke is complete:

```bash
npm run smoke:feishu -- --env-file scripts/feishu/.env --live --strict-live --require-todo120-native
```

`--strict-live` exits non-zero if any live check is skipped or failed. `--env-file` fills missing process env values from a local `KEY=value` file; shell env values still win. Before any live network call, the harness rejects invalid, placeholder, or missing required values and tells you to rerun `--check-env`, so `CHANGE_ME_*` templates and incomplete strict-live env files are not sent to Feishu. `--json` adds a machine-readable summary with missing env names, live coverage, and which checks write external data.

Write a safe evidence artifact for PRs or Feishu evidence verification. Evidence output is strict-live-success only: `--evidence` refuses dry-run commands and non-strict live runs, and a failed strict-live run prints diagnostics without writing the target file, so an existing live artifact is not overwritten by a local request-shape check or failed partial smoke. Before writing, the harness runs the same redaction and coverage verifier used by `--verify-evidence`; if the generated output contains unsafe callback URLs, raw Feishu identifiers, token-like text, or incomplete coverage, it fails with issue codes and writes nothing.

```bash
npm run smoke:feishu -- --env-file scripts/feishu/.env --live --strict-live --evidence runtime-output/feishu-smoke/live.json --require-todo120-native
```

The evidence file uses the same redacted schema as `--json`: request paths are tokenized, request bodies only list top-level keys, response data is summarized by code/message/data keys, and the callback probe records only the DofeAgent callback route plus a short route fingerprint instead of the full callback URL.

Verify an existing evidence artifact before using it in the final DofeAgent evidence gate:

```bash
npm run smoke:feishu -- --verify-evidence runtime-output/feishu-smoke/live.json --json
```

The verifier checks that the artifact came from a strict live run, every required DofeAgent callback, IM, Docs, Sheets, and Base live check passed, the callback step includes a safe DofeAgent route proof, the app identity is represented only by hashes, Docs/Sheets/Base write checks are marked destructive, request paths still use token placeholders, and step details do not contain raw Feishu ids, resource tokens, Sheets ranges, callback URLs, or secrets.

After bot, native multi-agent, guest-policy, data-plane, worker when using `websocket_worker`, and failure-visibility smoke has run through DofeAgent, use the combined DofeAgent evidence gate to verify local DB evidence, the redacted OpenAPI artifact, and the redacted real bot-added callback payload artifact. The local DofeAgent evidence must belong to an active agent-scoped Feishu bot binding; complete historical proof on a workspace-level, disabled, or archived binding is rejected. When `--integration` is provided, the final gate also checks that the OpenAPI artifact callback route fingerprint and both artifacts' app/tenant hashes match that workspace/integration; tenant hashes are accepted only when the scoped integration has the same saved tenant key. If no active Feishu agent bot binding exists, or `--integration` points at a missing, inactive, or workspace-level binding, the final evidence output reports `integration_missing` / `active_integration_missing` / `active_agent_bot_integration_missing` / `selected_integration_missing` / `selected_integration_not_active` / `selected_integration_not_agent_bot` at report level, echoes the selected integration id when present, and prints the `smoke-plan` / `bind-agent-bot` remediation before artifact-only steps. Per-integration evidence also prints the binding `status`, so workspace-level, disabled, or archived records are visible when their historical local rows are rejected. The smoke plan emits integration-scoped failure and evidence commands by default. For TODO120 native multi-agent smoke, `--require native` and the native portion of `--require all` use workspace-wide redacted DofeAgent evidence counters grouped by the same safe chat reference, so second-bot channel reuse and thread-collaboration evidence may live on a different agent bot binding in the same Feishu group while the selected integration still anchors callback proof and per-integration details. A scoped gate requires the selected integration to participate in that same safe-chat group, so an unrelated bot/group cannot make the selected integration pass native smoke; the non-native parts of `--require all` still require the same selected or workspace anchor integration's own active bot, guest-policy, data-plane, worker when that anchor uses `websocket_worker`, and failure evidence. Check `summary.workspaceNativeExperienceSatisfied` for the cross-bot native portion and `summary.scopedAllSatisfied` for the selected integration's local DofeAgent all gate before artifact validation. Check `summary.localEvidenceFreshRows` / `summary.localEvidenceStaleRows` for the scoped integration and `summary.workspaceLocalEvidenceFreshRows` / `summary.workspaceLocalEvidenceStaleRows` for workspace-wide native evidence; stale rows are ignored and only 24-hour local evidence can satisfy the gate. `strictSatisfied` may still be false when the local gate is true if either evidence artifact is missing, stale, mismatched, from a different app/tenant, carries an unbound tenant hash, was matched only to a disabled binding, or is not fully redacted. Data-plane evidence requires Doc read, Agent-triggered Doc read, approved Doc write, Sheet read, approved Sheet write with DofeAgent data table sync, Base read, approved Base mutation with DofeAgent data table sync, user actor provenance, and external_guest write-deny proof. `smoke-plan` and evidence remediation print the `auto-provision-policy` commands needed to switch external guest modes for reply_on_mention, reply_all, require_identity, and ignore live checks; temporary reply_all, require_identity, and ignore steps include a restore command back to reply_on_mention + channel_context_only in the step detail. The disabled agent/channel policy step prints an `agent-channel-access --access disabled` command for the agent-scoped bot target plus a matching restore command in the step detail; run the restore command after capturing the no-reply evidence. For the Agent runtime smoke, ask an Agent in the bound Feishu group to summarize the already-bound Feishu Doc so the same Feishu chat reply path also proves scoped Doc access from the task context. For WebSocket worker smoke, send one bound Feishu message before restarting the worker and one after restart; the DofeAgent evidence gate expects both replies to be correlated to their inbound Feishu messages. For failure smoke, leave a failed outbox or data-operation row visible and refresh health so the integration records degraded/error status before running the final gate.

For self-hosted WebSocket worker smoke, the worker JSON printed on shutdown includes `metrics.connectionReadyCount`, `metrics.connectionErrorCount`, and `connectionStatuses`. Use those fields together with the final evidence gate to confirm the worker reached ready state, surfaced sanitized connection errors, and reconnected after a restart without relying on a public callback URL. The worker command exits non-zero when it only observes connection errors or failed events and no successfully processed Feishu event, so automation can fail fast before the final evidence gate.
When smoke-plan can identify a `transportMode=websocket_worker` integration, its worker dry-run/start commands include `--integration <id>` so multi-integration workspaces validate the intended Feishu app instead of scanning every workspace integration.

```bash
dofe-agent integrations feishu evidence --workspace-id default --integration feishu-1 --openapi-evidence runtime-output/feishu-smoke/live.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --strict --require all
```

The live smoke covers:

- `@larksuiteoapi/node-sdk` `Client.im.message.create(...)`
- `EventDispatcher` handling `im.message.receive_v1`, `im.chat.member.bot.added_v1`, and `card.action.trigger`
- HTTP URL verification challenge response
- DofeAgent callback URL verification using the saved integration route and verification token
- Tenant access token acquisition for REST data-plane calls
- Docx metadata, block reads, and append-block write
- Sheets metadata, range read, and small range write
- Base/Bitable table list, record list, and single record update

Keep credentials and resource tokens out of git. The script prints safe response summaries and redacted request paths; API `code`/`msg` fields, error details, and response data keys are sanitized before stdout/JSON/evidence output, so app secrets, verification tokens, callback URLs, tenant tokens, resource tokens, chat ids, sheet ranges, and write payload values are not printed. The Doc append, Sheets write, and Base update checks mutate the configured smoke resources, so point them at disposable blocks/rows/cells.
