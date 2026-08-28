# Agent Pricing Deep Audit

> Superseded by the 2026-07-27 implementation closure. The findings below are
> retained as the pre-implementation audit trail and no longer describe the
> current branch. All repository-side P0/P1 findings were addressed, including
> remote-mode isolation, node provisioning, durable/atomic credentials,
> authoritative preflight and reconciliation, controlled recovery, browser
> redaction, and platform-admin audit isolation. See
> `docs/0727/agent-pricing/implementation-plan.md` for the current status and
> `npm run test:agent-pricing` for the isolated feature gate. Production enablement
> still requires staging E2E against real models, gateway, and container systems.

Date: 2026-07-27

## Verdict

`docs/0727/agent-pricing` has not been comprehensively implemented. The
repository contains a Phase 2 control-plane prototype and partial model
selection support, but it must not be released as the remote managed Runtime
or model-billing feature. The release blockers are deployment-mode isolation,
actual remote execution and credential mounting, and gateway billing
attribution/reconciliation.

The prescribed `code-review-graph` MCP tools are not exposed in this Codex
session. Per `AGENTS.md`, the review therefore fell back to targeted static
search, source inspection, Git state, and focused type checking. No source
files were changed by this review.

## Implementation Matrix

| Plan phase | Status | Evidence |
| --- | --- | --- |
| Phase 0: contract, mode, security baseline | Partial | SDK client and role checks exist, but no production reference to `DOFE_AGENT_RUNTIME_MODE` was found outside documentation. |
| Phase 1: models RuntimeCredential capability | Not independently verifiable | The plan records it complete in the external `models.dofe.ai` repository. This repository calls `@dofe/models-sdk`, but contains neither the referenced models service nor its contract tests. |
| Phase 2: AgentSpace task/control-plane | Partial | Durable tasks, idempotency, tenant/team scope, audit records, retry and cancel compensation exist. Mode gate, existing-Runtime reuse, full lifecycle state machine, and all authorisation rules do not. |
| Phase 3: node credential resolution and managed installation | Not implemented | Pipeline deliberately skips image pull and CLI installation; secret vault is process-memory only and no node/volume/gateway adapter consumes it. |
| Phase 4: model configuration and sessions | Partial | Precedence and credential-directory lookup exist for managed Runtime execution. Server-side create/default/override validation and the specified interaction are incomplete. |
| Phase 5: usage, billing, reconciliation, terminology | Not implemented / partial | Local price-table estimates and basic usage records exist. models balances, actual usage, reconciliation, statuses, alerts, and systematic AI Employee terminology migration are absent. |

## Findings

### P0: `local` instances can enter the managed models flow

The specification requires startup parsing of `DOFE_AGENT_RUNTIME_MODE`, a
default of `local`, and zero new models-management calls in `local`
([implementation plan](/docs/0727/agent-pricing/implementation-plan.md:3),
[product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:145)).
There is no non-documentation reference to that variable. The server action
always invokes managed provisioning
([actions.ts](/apps/web/features/runtimes/actions.ts:43)), and the service
immediately creates a task and starts the models pipeline
([runtime-provisioning.ts](/packages/services/src/runtime-provisioning/runtime-provisioning.ts:99)).

Impact: a default/local deployment can expose the remote Runtime UI and call
models.dofe.ai. This violates the primary safety and backward-compatibility
boundary.

### P0: a Runtime becomes `ready` without being installed, credential-mounted, or gateway-enforced

The required remote path includes controlled installation, atomic credential
mounting, fixed gateway URLs, protocol health checks, and cleanup
([implementation plan](/docs/0727/agent-pricing/implementation-plan.md:63),
[architecture](/docs/0727/agent-pricing/README.md:167)). The provisioning
pipeline explicitly skips `pull_image` and `install_cli`
([runtime-provisioning.ts](/packages/services/src/runtime-provisioning/runtime-provisioning.ts:547)),
then treats the existence of a DB credential ID as the health check and marks
the Runtime ready ([runtime-provisioning.ts](/packages/services/src/runtime-provisioning/runtime-provisioning.ts:567)).

The default secret vault is an in-memory map, so a process restart loses the
key ([credential-vault.ts](/packages/services/src/runtime-provisioning/credential-vault.ts:9)).
The node credential resolver only supports legacy provider-account environment
maps ([provider-credentials.ts](/packages/daemon/src/provider-credentials.ts:35));
there is no consumer for `runtimeCredentialId` / `credentialSecretRef`. During
execution, the daemon only sets a model-name environment variable
([daemon.ts](/apps/cli/src/commands/daemon.ts:1527)); it neither mounts the
Runtime key nor injects the required `model.local.dofe.ai/api` protocol endpoint.

Impact: a UI-visible “ready” Runtime can be unusable after restart or still
use host-local Provider credentials, breaking isolation, billing, and the
no-manual-Provider promise.

### P0: gateway billing, trusted attribution, and reconciliation are absent

The contract requires signed Runtime-key attribution headers and actual
gateway usage records, including amount, currency, billing state and gateway
usage ID ([models contract](/docs/0727/agent-pricing/models-contract.md:161)).
The daemon sends only local context environment variables
([daemon.ts](/apps/cli/src/commands/daemon.ts:1081)); it does not create the
required HMAC headers or consume gateway usage records.

`token_usage` calculates `cost_usd` from a static local price table
([token-usage.ts](/packages/db/src/token-usage.ts:4),
[token-usage.ts](/packages/db/src/token-usage.ts:77)), and the cost service
only aggregates that field ([costs.ts](/packages/services/src/costs/costs.ts:44)).
There is no models balance view, Runtime-Key actual usage, unallocated cost,
reconciliation snapshot, cost status, or idempotent re-run path.

Impact: the product cannot distinguish estimated attribution from actual
charges as required by the specification
([product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:323)).

### P1: members can create and operate their own AI Employees

The specification gives AI Employee creation, execution, configuration and
deletion only to Owner/Admin ([product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:273)).
`createWorkspaceAgentAction` permits a member to create an employee whenever
they supply a Runtime to which they were granted access
([agents/actions.ts](/apps/web/features/agents/actions.ts:175)). It assigns the
member as `ownerUserId`; the subsequent access rule explicitly permits the
owner to manage the employee ([runtime-access.ts](/packages/services/src/runtime-access/runtime-access.ts:219)).

Impact: the documented Owner/Admin/Member security boundary is bypassed via
normal server actions, not merely a missing UI control.

### P1: members can also read the remote model catalog and prices

The model-and-cost areas are Owner/Admin-only in the product information
architecture ([product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:185)).
However, the pre-credential catalog action uses only `requireWorkspaceActor`
([runtimes/actions.ts](/apps/web/features/runtimes/actions.ts:134)), then
returns protocol information and input/output prices
([runtimes/actions.ts](/apps/web/features/runtimes/actions.ts:158)).

Impact: a Member can bypass the intended product boundary by invoking the
server action directly and retrieve management pricing data even though they
cannot open the managed Runtime page.

### P1: invalid models and insufficient balance are not rejected at the server-side creation boundary

The product requires no Key creation when no compatible model exists or a
balance preflight fails ([product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:310)).
The service accepts caller-provided `defaultModel`, `protocols`, and
`allowedModels` without catalog or balance validation
([runtime-provisioning.ts](/packages/services/src/runtime-provisioning/runtime-provisioning.ts:89)).
The creation UI also allows an empty model
([runtimes-page-client.tsx](/apps/web/features/runtimes/runtimes-page-client.tsx:50)).
The pre-credential UI catalog is tenant-wide protocol filtering rather than a
RuntimeCredential-filtered catalog ([runtimes/actions.ts](/apps/web/features/runtimes/actions.ts:134)).

Impact: malicious or stale clients can request a Key/install that should have
failed before resource allocation.

### P1: key-invalid recovery is manual, and fallback masks invalid `/model` requests

The design requires one controlled automatic rotation after a credential
invalid signal, with escalation for repeated failure and no rotation for
business rejections ([architecture](/docs/0727/agent-pricing/README.md:146)).
The only production caller of rotation is the administrator button
([runtimes-page-client.tsx](/apps/web/features/runtimes/runtimes-page-client.tsx:175));
no gateway-rejected event handler or recovery state exists.

Separately, an incompatible session/employee/default model is silently
replaced with the first available model after a best-effort audit
([model-resolution.ts](/packages/services/src/models/model-resolution.ts:86)).
The specified behaviour is to retain the prior model and reject the new
override ([product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:317).

Impact: operators see no deterministic recovery path, and users may receive a
different model from the one they selected.

### P1: concurrent tasks can overwrite each other's selected model

The daemon runs Runtime work asynchronously, but `runProviderTaskWithModel`
temporarily mutates process-global `CLAUDE_MODEL`, `CODEX_MODEL`, and related
variables ([daemon.ts](/apps/cli/src/commands/daemon.ts:1527)). A second task
for the same provider can replace the value before the first provider process
is created or completes.

Impact: two sessions sharing a Runtime can execute a model selected by another
task, invalidating the per-session precedence requirement and corrupting model
and cost attribution. Pass an immutable per-invocation environment to the
provider subprocess/runner, or enforce a deliberate serialization policy;
add a concurrency regression test.

### P2: UI exposes credential implementation references

Task details render `credentialSecretRef` directly
([task-detail-client.tsx](/apps/web/features/runtimes/task-detail-client.tsx:129)),
and a server action returns it to the browser
([runtimes/actions.ts](/apps/web/features/runtimes/actions.ts:203)). The value
is not plaintext, but the product requires task diagnostics to show only
redacted summaries and no secret reference
([product specification](/docs/0727/agent-pricing/00-产品需求与交付规格.md:268).

Impact: secret-store topology and opaque locator values are exposed to every
workspace administrator, unnecessarily widening the sensitive-data surface.

### P2: terminology migration remains incomplete

The plan requires systematic migration of user-facing “Agent” to “AI员工 / AI
Employee” ([implementation plan](/docs/0727/agent-pricing/implementation-plan.md:88)).
Examples still visible in primary UI include the creation modal
([create-agent-modal.tsx](/apps/web/features/agents/components/create-agent-modal.tsx:130)),
cost breakdown ([costs-page-client.tsx](/apps/web/features/costs/costs-page-client.tsx:153)),
and workspace navigation ([workspace-frame.tsx](/apps/web/features/dashboard/workspace-frame.tsx:709)).

## Implemented, But Not Sufficient

- RuntimeCredential create/rotate/revoke calls carry tenant/team scope; managed
  Runtime mutations require Owner/Admin
  ([runtime-provisioning.ts](/packages/services/src/runtime-provisioning/runtime-provisioning.ts:58)).
- Provisioning tasks persist stages, idempotency key, retry count, events, and
  cancellation compensation
  ([runtime-provisioning-tasks.ts](/packages/db/src/runtime-provisioning-tasks.ts:49)).
- Model precedence is implemented for managed Runtime execution: session,
  employee, Runtime, team policy, protocol fallback
  ([model-resolution.ts](/packages/services/src/models/model-resolution.ts:86)).
- UI supports polling, task stage display, retry, cancel, manual rotation,
  stop, and delete ([task-detail-client.tsx](/apps/web/features/runtimes/task-detail-client.tsx:26)).

## Verification

- `npm run typecheck:deps`: passed.
- Targeted Vitest invocation could not discover tests outside the web package
  include roots; it exited with `No test files found`. This is a test-command
  configuration gap, not a test pass.
- The workspace was clean when the audit began. During review, unrelated
  untracked chat implementation files appeared (including
  `apps/web/features/chat/model-command.ts` and `packages/services/src/chat/`);
  they were not read, changed, or included in the findings. The two audit
  artifacts are the only files created by this review.
