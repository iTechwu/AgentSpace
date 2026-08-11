import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  createCapabilityRequestSync,
  createUserSync,
  createWorkspaceMembershipSync,
  decideCapabilityRequestSync,
  getDatabase,
  listManagedSkillServiceOperationsSync,
  listMcpConnectionsSync,
  randomLikeId,
  readCapabilityRequestSync,
  readRuntimeAppOperationSync,
  upsertMcpCatalogItemSync,
  upsertRuntimeAppCatalogItemsSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import { chainCapabilityRuntimeBaselineSync, resetWorkspaceStateSync } from "../index.ts";
import {
  approveCapabilityRequestSync,
  cancelCapabilityRequestSync,
  completeCapabilityRequestMcpConnectionSync,
  submitCapabilityRequestSync,
  switchCapabilityImplementationSync,
} from "./capability-workflow.ts";
import { setBaselineRegistryForTests } from "./baseline-releases.ts";

/**
 * Capability request workflow (docs/0811/cli-install Phase 4/6): submit-time
 * deployment re-derivation and admin approval dispatch. DB-backed — runs in CI
 * where the shared test Postgres schema is current.
 */

let testUserId: string;

beforeEach(() => {
  resetWorkspaceStateSync();
  testUserId = createUserSync({ displayName: "Requester", primaryEmail: `req-${randomLikeId()}@example.com` }).id;
});

function createTestRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, version, status, device_info, metadata_json, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, '1.0.0', 'online', '{}', '{}', ?, ?)`,
  ).run(id, `Test Runtime ${id}`, now, now);
  return id;
}

function seedMcpCatalog(slug: string, source = "official"): string {
  return upsertMcpCatalogItemSync({
    workspaceId: "default",
    source: source as never,
    slug,
    version: "1.0.0",
    transport: "streamable_http",
    displayName: "Test MCP",
    category: "productivity",
    risk: "low",
    declaredToolsJson: JSON.stringify([{ name: "search", description: "Search", risk: "low" }]),
    defaultApprovedToolsJson: JSON.stringify(["search"]),
    allowedHostsJson: JSON.stringify(["mcp.example.com"]),
    endpointTemplate: "https://mcp.example.com/mcp",
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
  }).id;
}

function baseMcpSubmit(runtimeId: string, slug: string) {
  return {
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "mcp" as const,
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Test MCP",
    deploymentMode: "external_service" as const,
    requestedAction: "connect" as const,
  };
}

test("submit rejects an unresolvable catalog entry instead of accepting the client declaration", () => {
  const runtimeId = createTestRuntime();
  assert.throws(
    () => submitCapabilityRequestSync(baseMcpSubmit(runtimeId, `missing-${randomLikeId()}`)),
    /capability_request\.catalog_not_found/,
  );
});

test("submit overrides a client external_service claim for a service-kind request to managed_service", () => {
  const runtimeId = createTestRuntime();
  const slug = `svc-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  const result = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "service",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Heavy Service",
    deploymentMode: "external_service", // client claims external — must be overridden
    requestedAction: "deploy",
  });
  const stored = readCapabilityRequestSync(result.capabilityRequest.id, "default");
  assert.equal(stored?.deploymentMode, "managed_service", "service kind has no external lifecycle; mode must be re-derived");
});

test("submit makes the catalog source authoritative for a same-slug multi-source catalog", () => {
  const runtimeId = createTestRuntime();
  const slug = `mcp-${randomLikeId()}`;
  seedMcpCatalog(slug, "official");
  const result = submitCapabilityRequestSync({
    ...baseMcpSubmit(runtimeId, slug),
    packageSource: "workspace_private", // client tries a different source
  });
  // The stored request must use the catalog's authoritative source (SP4).
  const stored = readCapabilityRequestSync(result.capabilityRequest.id, "default");
  assert.equal(stored?.packageSource, "official");
  assert.equal(stored?.deploymentMode, "external_service");
});

test("admin approval of a managed_service request dispatches a real container provision", () => {
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const slug = `svc-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  // Grant the actor the owner role so approval passes.
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });

  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "service",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Heavy Service",
    deploymentMode: "managed_service",
    requestedAction: "deploy",
  });
  // Admin submit auto-approves; the service driver queues a provision op.
  assert.equal(submitted.capabilityRequest.status, "running");
  assert.ok(submitted.dispatchedOperationId, "provision operation must be dispatched");

  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", limit: 20 });
  assert.equal(ops.some((op) => op.id === submitted.dispatchedOperationId && op.operation === "provision"), true);
});

test("re-approval of a still-gated managed_service request restores approved instead of phantom-running (Spec P1)", () => {
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "0";
  const runtimeId = createTestRuntime();
  const slug = `svc-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "service",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Gated Service",
    deploymentMode: "managed_service",
    requestedAction: "deploy",
  });
  assert.equal(submitted.capabilityRequest.status, "approved", "gated managed_service stays approved (no phantom op)");
  assert.equal(submitted.dispatchedOperationId, undefined, "no operation is queued while gated");
  // Re-approval while STILL gated must not leave the CAS-claimed request stuck
  // in running — it must be restored to approved for a future re-dispatch.
  const reapproved = approveCapabilityRequestSync({
    workspaceId: "default",
    requestId: submitted.capabilityRequest.id,
    actorUserId: testUserId,
    decision: "approved",
  });
  assert.equal(reapproved.capabilityRequest.status, "approved", "still-gated re-approval must restore approved, not phantom-run");
  const after = readCapabilityRequestSync(submitted.capabilityRequest.id, "default");
  assert.ok(after?.linkedRuntimeAppOperationId == null, "no operation may be created while gated");
});

test("switchCapabilityImplementationSync fails closed when the catalog cannot back the alternative (Spec P1)", () => {
  const runtimeId = createTestRuntime();
  const name = `switch-cli-${randomLikeId()}`;
  // pip-strategy CLI → the catalog resolves it to runtime_package.
  seedBaselineCli(name);
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  // Same implementation the catalog resolves → the switch submits a request.
  const switched = switchCapabilityImplementationSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "cli",
    packageSource: "clihub_public",
    packageSlug: name,
    packageDisplayName: "Switch CLI",
    targetImplementation: "runtime_package",
  });
  assert.equal(switched.capabilityRequest.deploymentMode, "runtime_package");
  // A different implementation the catalog cannot back → fail closed, no request.
  assert.throws(
    () => switchCapabilityImplementationSync({
      workspaceId: "default",
      runtimeId,
      actorUserId: testUserId,
      packageKind: "cli",
      packageSource: "clihub_public",
      packageSlug: name,
      packageDisplayName: "Switch CLI",
      targetImplementation: "external_service",
    }),
    /capability_request\.implementation_not_supported/,
  );
});

test("switchCapabilityImplementationSync requires an admin and maps external MCP to connect", () => {
  const runtimeId = createTestRuntime();
  const slug = `switch-mcp-${randomLikeId()}`;
  seedMcpCatalog(slug, "official");
  assert.throws(
    () => switchCapabilityImplementationSync({
      workspaceId: "default",
      runtimeId,
      actorUserId: testUserId,
      packageKind: "mcp",
      packageSource: "official",
      packageSlug: slug,
      packageDisplayName: "Switch MCP",
      targetImplementation: "external_service",
    }),
    /owners and admins can switch/,
  );
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  const switched = switchCapabilityImplementationSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Switch MCP",
    targetImplementation: "external_service",
  });
  assert.equal(switched.capabilityRequest.requestedAction, "connect");
});

function seedManagedServiceTemplate(slug: string): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    templateDigest: `sha256:${"b".repeat(64)}`,
    sbomDigest: `sha256:${"c".repeat(64)}`,
    protocol: "http",
    networkJson: JSON.stringify({ ingress: "private" }),
    healthJson: JSON.stringify({ path: "/healthz" }),
    resourcesJson: JSON.stringify({ cpu: "250m", memory: "128Mi" }),
  }).id;
}

test("completeCapabilityRequestMcpConnectionSync accepts a deploy approval (P0) and refuses an unapproved request", () => {
  const runtimeId = createTestRuntime();
  const slug = `mcp-${randomLikeId()}`;
  const catalogId = seedMcpCatalog(slug, "official");
  // The market panel submits `deploy` for request_deployment on a managed MCP,
  // then the applicant finishes the connection — a deploy approval MUST be
  // consumable by the completion path (P0-S2).
  const request = createCapabilityRequestSync({
    workspaceId: "default",
    requestedByUserId: testUserId,
    runtimeId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Test MCP",
    deploymentMode: "managed_service",
    requestedAction: "deploy",
    metadataJson: JSON.stringify({ catalogItemId: catalogId }),
  }).record;
  decideCapabilityRequestSync({
    requestId: request.id,
    workspaceId: "default",
    decidedByUserId: testUserId,
    decision: "approved",
  });
  const completed = completeCapabilityRequestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: testUserId,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://mcp.example.com/mcp",
  });
  assert.ok(completed.connectionId, "deploy approval must be consumable by the connection completion");

  // A rejected request must still be refused.
  const rejected = createCapabilityRequestSync({
    workspaceId: "default",
    requestedByUserId: testUserId,
    runtimeId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: `mcp-${randomLikeId()}`,
    packageDisplayName: "Test MCP",
    deploymentMode: "managed_service",
    requestedAction: "deploy",
    metadataJson: "{}",
  }).record;
  decideCapabilityRequestSync({
    requestId: rejected.id,
    workspaceId: "default",
    decidedByUserId: testUserId,
    decision: "rejected",
    decisionReason: "no",
  });
  assert.throws(
    () => completeCapabilityRequestMcpConnectionSync({
      workspaceId: "default",
      actorUserId: testUserId,
      runtimeId,
      catalogItemId: catalogId,
      endpoint: "https://mcp.example.com/mcp",
    }),
    /capability_request\.not_approved/,
  );
});

test("MCP completion refuses a legacy approved request without an immutable catalog pin", () => {
  const runtimeId = createTestRuntime();
  const slug = `legacy-mcp-${randomLikeId()}`;
  const catalogId = seedMcpCatalog(slug, "official");
  const request = createCapabilityRequestSync({
    workspaceId: "default",
    requestedByUserId: testUserId,
    runtimeId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Legacy MCP",
    deploymentMode: "external_service",
    requestedAction: "connect",
    metadataJson: "{}",
  }).record;
  decideCapabilityRequestSync({
    requestId: request.id,
    workspaceId: "default",
    decidedByUserId: testUserId,
    decision: "approved",
  });
  assert.throws(
    () => completeCapabilityRequestMcpConnectionSync({
      workspaceId: "default",
      actorUserId: testUserId,
      runtimeId,
      catalogItemId: catalogId,
      endpoint: "https://mcp.example.com/mcp",
    }),
    /capability_request\.not_approved/,
  );
});

test("completion resolves the daemon provisioned endpoint server-side (Spec P0)", () => {
  const runtimeId = createTestRuntime();
  const slug = `mcp-${randomLikeId()}`;
  // managed_service transport catalog (not the openmontage static template) —
  // only a runtime-private:// endpoint passes its validation.
  const catalogId = upsertMcpCatalogItemSync({
    workspaceId: "default",
    source: "official" as never,
    slug,
    version: "1.0.0",
    transport: "managed_service",
    displayName: "Managed MCP",
    category: "productivity",
    risk: "medium",
    declaredToolsJson: JSON.stringify([{ name: "tool", description: "T", risk: "low" }]),
    defaultApprovedToolsJson: JSON.stringify(["tool"]),
    endpointTemplate: "managed-service://test",
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
  }).id;
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  // Approved request whose provision convergence stored the daemon's container
  // endpoint (provisionedEndpointRef), as the driver now does.
  const request = createCapabilityRequestSync({
    workspaceId: "default",
    requestedByUserId: testUserId,
    runtimeId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Managed MCP",
    deploymentMode: "managed_service",
    requestedAction: "connect",
    metadataJson: JSON.stringify({ catalogItemId: catalogId, provisionedEndpointRef: "runtime-private://svc-abc" }),
  }).record;
  decideCapabilityRequestSync({
    requestId: request.id,
    workspaceId: "default",
    decidedByUserId: testUserId,
    decision: "approved",
  });
  // The client submits a bogus public endpoint — the server must override it with
  // the stored runtime-private ref (the browser never carries the private one).
  const completed = completeCapabilityRequestMcpConnectionSync({
    workspaceId: "default",
    actorUserId: testUserId,
    runtimeId,
    catalogItemId: catalogId,
    endpoint: "https://evil.example.com/mcp",
  });
  const conn = listMcpConnectionsSync({ workspaceId: "default", runtimeId, limit: 10 })
    .find((candidate) => candidate.id === completed.connectionId);
  assert.equal(conn?.endpoint, "runtime-private://svc-abc", "completion must use the server-stored provisioned endpoint");
});

test("cancelCapabilityRequestSync lets the applicant cancel their pending request", () => {
  const runtimeId = createTestRuntime();
  const slug = `mcp-${randomLikeId()}`;
  seedMcpCatalog(slug, "official");
  const submitted = submitCapabilityRequestSync(baseMcpSubmit(runtimeId, slug));
  // Non-admin submit → pending.
  assert.equal(submitted.capabilityRequest.status, "pending");

  const cancelled = cancelCapabilityRequestSync({
    requestId: submitted.capabilityRequest.id,
    workspaceId: "default",
    actorUserId: testUserId,
  });
  assert.equal(cancelled?.status, "cancelled");
});

test("cancelCapabilityRequestSync refuses a non-owner cancel", () => {
  const runtimeId = createTestRuntime();
  const slug = `mcp-${randomLikeId()}`;
  seedMcpCatalog(slug, "official");
  const submitted = submitCapabilityRequestSync(baseMcpSubmit(runtimeId, slug));
  const otherUser = createUserSync({ displayName: "Other", primaryEmail: `other-${randomLikeId()}@example.com` }).id;
  assert.throws(
    () => cancelCapabilityRequestSync({
      requestId: submitted.capabilityRequest.id,
      workspaceId: "default",
      actorUserId: otherUser,
    }),
    /capability_request\.not_owner/,
  );
});

function seedBaselineCli(name: string): void {
  upsertRuntimeAppCatalogItemsSync([{
    source: "clihub_public",
    name,
    displayName: "Baseline CLI",
    version: "1.0.0",
    entryPoint: "requests",
    installStrategy: "pip",
    installCmd: "pip install requests",
    registryJson: JSON.stringify({ pypi_package_spec: "requests==2.31.0" }),
  }]);
}

test("admin CLI install dispatches a baseline op first when the runtime lacks the tool (rollout enabled)", () => {
  process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED = "1";
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const name = `baseline-cli-${randomLikeId()}`;
  // Seed a pip-strategy CLI; no daemon snapshot ⇒ readiness reports pip missing,
  // so dispatch queues a pip baseline op (ensurepip) before the CLI op.
  seedBaselineCli(name);
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });

  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "cli",
    packageSource: "clihub_public",
    packageSlug: name,
    packageDisplayName: "Baseline CLI",
    deploymentMode: "runtime_package",
    requestedAction: "install",
  });
  assert.equal(submitted.capabilityRequest.status, "running");

  const baselineOp = readRuntimeAppOperationSync(submitted.dispatchedOperationId!, "default");
  assert.ok(baselineOp?.appName.startsWith("runtime-baseline:"), "dispatch must queue a baseline op first");
  assert.equal(baselineOp?.appName, "runtime-baseline:pip", "baseline op installs the missing tool");
  const linked = readCapabilityRequestSync(submitted.capabilityRequest.id, "default");
  const metadata = JSON.parse(linked?.metadataJson ?? "{}") as Record<string, unknown>;
  assert.equal(typeof metadata.pendingCliPlan, "string", "CLI plan must be stored for chaining");

  // Baseline succeeds → CLI op is created and the request re-links to it.
  chainCapabilityRuntimeBaselineSync({
    workspaceId: "default",
    operationId: submitted.dispatchedOperationId!,
    outcome: "succeeded",
  });
  const afterBaseline = readCapabilityRequestSync(submitted.capabilityRequest.id, "default");
  const cliOp = readRuntimeAppOperationSync(afterBaseline?.linkedRuntimeAppOperationId ?? "", "default");
  assert.equal(cliOp?.appName, name, "CLI op must be created after baseline");
  assert.equal(afterBaseline?.status, "running");
});

test("concurrent baseline completion callbacks chain exactly once (Spec P1)", () => {
  process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED = "1";
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const name = `baseline-cli-${randomLikeId()}`;
  seedBaselineCli(name);
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "cli",
    packageSource: "clihub_public",
    packageSlug: name,
    packageDisplayName: "Baseline CLI",
    deploymentMode: "runtime_package",
    requestedAction: "install",
  });
  const baselineOp = readRuntimeAppOperationSync(submitted.dispatchedOperationId!, "default");
  assert.ok(baselineOp?.appName.startsWith("runtime-baseline:"));

  // A duplicate completion callback (the CAS guard / re-link makes this a no-op)
  // must NOT create a second CLI op.
  chainCapabilityRuntimeBaselineSync({ workspaceId: "default", operationId: baselineOp!.id, outcome: "succeeded" });
  chainCapabilityRuntimeBaselineSync({ workspaceId: "default", operationId: baselineOp!.id, outcome: "succeeded" });

  const after = readCapabilityRequestSync(submitted.capabilityRequest.id, "default");
  assert.equal(after?.status, "running");
  const cliOps = getDatabase().prepare(
    "SELECT id FROM runtime_app_operation WHERE app_name = ? AND workspace_id = 'default'",
  ).all(name);
  assert.equal(cliOps.length, 1, "exactly one CLI op must be created across duplicate callbacks");
  const linkedCli = getDatabase().prepare(
    "SELECT app_name FROM runtime_app_operation WHERE id = ?",
  ).get(after?.linkedRuntimeAppOperationId ?? "") as { app_name?: string } | undefined;
  assert.equal(linkedCli?.app_name, name, "request must link to the single CLI op");
});

test("a failed baseline install fails the capability request closed", () => {
  process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const name = `baseline-cli-${randomLikeId()}`;
  seedBaselineCli(name);
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "cli",
    packageSource: "clihub_public",
    packageSlug: name,
    packageDisplayName: "Baseline CLI",
    deploymentMode: "runtime_package",
    requestedAction: "install",
  });
  const baselineOp = readRuntimeAppOperationSync(submitted.dispatchedOperationId!, "default");
  assert.ok(baselineOp?.appName.startsWith("runtime-baseline:"));

  chainCapabilityRuntimeBaselineSync({
    workspaceId: "default",
    operationId: submitted.dispatchedOperationId!,
    outcome: "failed",
    errorCode: "runtime_app.baseline_failed",
    errorMessage: "ensurepip failed",
  });
  const afterFail = readCapabilityRequestSync(submitted.capabilityRequest.id, "default");
  assert.equal(afterFail?.status, "failed");
  assert.equal(afterFail?.lastErrorCode, "runtime_app.baseline_failed");
});

import { buildRuntimeBaselineInstallPlan } from "./capability-dispatchers.ts";

test("baseline tools fail closed without a configured pinned artifact", () => {
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_INTEGRITY;
  delete process.env.DOFE_AGENT_BASELINE_PYTHON_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_PYTHON_ARTIFACT_INTEGRITY;
  delete process.env.DOFE_AGENT_BASELINE_UV_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_UV_ARTIFACT_INTEGRITY;
  delete process.env.DOFE_AGENT_BASELINE_CLIHUB_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_CLIHUB_ARTIFACT_INTEGRITY;
  assert.equal(buildRuntimeBaselineInstallPlan("npm"), null, "image-level npm must fail closed unless pinned");
  assert.equal(buildRuntimeBaselineInstallPlan("python"), null);
  // uv/cli-hub have NO un-governed fallback — an unpinned install violates the
  // immutable baseline/release gate, so they fail closed too (Spec P1).
  assert.equal(buildRuntimeBaselineInstallPlan("uv"), null, "uv must fail closed unless pinned");
  assert.equal(buildRuntimeBaselineInstallPlan("cli_hub"), null, "cli-hub must fail closed unless pinned");
});

test("baseline npm plan conforms to the daemon artifact contract when ops pins one", () => {
  process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL = "https://nodejs.org/dist/v20.0.0/node-v20.0.0-darwin-x64.tar.gz";
  process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_INTEGRITY = `sha256-${"a".repeat(64)}`;
  const plan = buildRuntimeBaselineInstallPlan("npm");
  assert.ok(plan, "configured pin must produce a plan");
  assert.equal(plan.artifactLock?.url, "https://nodejs.org/dist/v20.0.0/node-v20.0.0-darwin-x64.tar.gz");
  assert.equal(plan.artifactLock?.integrity, `sha256-${"a".repeat(64)}`);
  // Daemon parseRuntimeAppInstallPlan contract: workspace_private source,
  // .runtime-app-artifacts/ localPath, integrityLock === artifact integrity.
  assert.equal(plan.app.source, "workspace_private", "plan app.source must satisfy the daemon contract");
  assert.ok(plan.artifactLock?.localPath.startsWith(".runtime-app-artifacts/"), "artifact localPath must be under .runtime-app-artifacts/");
  assert.equal(plan.integrityLock, plan.artifactLock?.integrity, "integrityLock must equal the artifact integrity");
  assert.equal(plan.commands[0]?.executable, "mkdir");
  assert.deepEqual(plan.commands[0]?.args, ["-p", ".baseline"]);
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_INTEGRITY;
});

test("baseline plan fails closed when a release requires unsupported signature verification", () => {
  setBaselineRegistryForTests([{
    tool: "uv",
    version: "0.4.10",
    artifactUrl: "https://files.pythonhosted.org/packages/uv-0.4.10.tar.gz",
    integrity: `sha256-${"a".repeat(64)}`,
    signatureRequired: true,
  }]);
  assert.equal(buildRuntimeBaselineInstallPlan("uv"), null);
  setBaselineRegistryForTests([]);
});

test("managed_stdio MCP dispatches a dependency CLI install first (P0)", () => {
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const depName = `dep-${randomLikeId()}`;
  // CLI dependency the MCP needs.
  upsertRuntimeAppCatalogItemsSync([{
    source: "clihub_public",
    name: depName,
    displayName: "Dep CLI",
    version: "1.0.0",
    entryPoint: depName,
    installStrategy: "npm",
    installCmd: `npm install -g ${depName}`,
    registryJson: JSON.stringify({ npm_package_spec: `${depName}@1.0.0` }),
  }]);
  // managed_stdio MCP requiring that CLI; NOT installed on the runtime.
  const mcpSlug = `mcp-${randomLikeId()}`;
  upsertMcpCatalogItemSync({
    workspaceId: "default",
    source: "official" as never,
    slug: mcpSlug,
    version: "1.0.0",
    transport: "managed_stdio",
    displayName: "Stdio MCP",
    category: "productivity",
    risk: "medium",
    declaredToolsJson: JSON.stringify([{ name: "tool", description: "T", risk: "low" }]),
    defaultApprovedToolsJson: JSON.stringify(["tool"]),
    endpointTemplate: "stdio://dep",
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
    requiredRuntimeAppJson: JSON.stringify({ source: "clihub_public", name: depName, version: "1.0.0" }),
  });
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });

  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: mcpSlug,
    packageDisplayName: "Stdio MCP",
    deploymentMode: "managed_service",
    requestedAction: "connect",
  });
  assert.equal(submitted.capabilityRequest.status, "running");
  const depOp = readRuntimeAppOperationSync(submitted.dispatchedOperationId!, "default");
  // The dependency op uses the REAL catalog identity so the installed-app lands
  // under the key the connection readiness check queries (Standard P0) — not a
  // synthetic mcp-dependency: namespace.
  assert.equal(depOp?.appName, depName, "dependency op must use the real CLI catalog identity");
  assert.equal(depOp?.appSource, "clihub_public", "dependency op must use the real CLI catalog source");
  const requestRow = getDatabase()
    .prepare("SELECT metadata_json AS metadataJson FROM capability_request WHERE id = ?")
    .get(submitted.capabilityRequest.id) as { metadataJson?: string };
  const metadata = JSON.parse(requestRow?.metadataJson ?? "{}") as Record<string, unknown>;
  assert.ok(metadata.mcpPendingConnect, "dependency dispatch must mark mcpPendingConnect so convergence does not stamp terminal");
});

test("managed_stdio MCP re-queues the dependency when an older version is installed (Spec P0)", () => {
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const depName = `dep-${randomLikeId()}`;
  upsertRuntimeAppCatalogItemsSync([{
    source: "clihub_public",
    name: depName,
    displayName: "Dep CLI",
    version: "2.0.0",
    entryPoint: depName,
    installStrategy: "npm",
    installCmd: `npm install -g ${depName}`,
    registryJson: JSON.stringify({ npm_package_spec: `${depName}@2.0.0` }),
  }]);
  const mcpSlug = `mcp-${randomLikeId()}`;
  upsertMcpCatalogItemSync({
    workspaceId: "default",
    source: "official" as never,
    slug: mcpSlug,
    version: "1.0.0",
    transport: "managed_stdio",
    displayName: "Stdio MCP",
    category: "productivity",
    risk: "medium",
    declaredToolsJson: JSON.stringify([{ name: "tool", description: "T", risk: "low" }]),
    defaultApprovedToolsJson: JSON.stringify(["tool"]),
    endpointTemplate: "stdio://dep",
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }),
    requiredRuntimeAppJson: JSON.stringify({ source: "clihub_public", name: depName, version: "2.0.0" }),
  });
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  // An OLD version is already installed on the runtime.
  getDatabase().prepare(
    `INSERT INTO runtime_installed_app (id, workspace_id, runtime_id, source, name, display_name, version, entry_point, status, install_strategy, enabled, installed_at, updated_at)
     VALUES (?, 'default', ?, ?, ?, ?, '1.0.0', ?, 'installed', 'npm', 1, ?, ?)`,
  ).run(`runtime-app-${randomLikeId()}`, runtimeId, "clihub_public", depName, depName, depName, new Date().toISOString(), new Date().toISOString());

  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "mcp",
    packageSource: "official",
    packageSlug: mcpSlug,
    packageDisplayName: "Stdio MCP",
    deploymentMode: "managed_service",
    requestedAction: "connect",
  });
  assert.equal(submitted.capabilityRequest.status, "running");
  const depOp = readRuntimeAppOperationSync(submitted.dispatchedOperationId!, "default");
  assert.equal(depOp?.appName, depName, "version mismatch must re-queue the dependency install (pinned to required version)");
});

test("cancel after container provision queues an explicit retire and frees the request (real lifecycle)", () => {
  process.env.MANAGED_SERVICE_PROVISIONING_ENABLED = "1";
  const runtimeId = createTestRuntime();
  const slug = `svc-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: testUserId,
    role: "owner",
    status: "active",
    invitedBy: testUserId,
  });
  const submitted = submitCapabilityRequestSync({
    workspaceId: "default",
    runtimeId,
    actorUserId: testUserId,
    packageKind: "service",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Heavy Service",
    deploymentMode: "managed_service",
    requestedAction: "deploy",
  });
  assert.equal(submitted.capabilityRequest.status, "running");
  assert.ok(submitted.dispatchedOperationId, "provision op must be dispatched");

  // Simulate the daemon provisioning the container to ready.
  const provisionOpId = submitted.dispatchedOperationId;
  const op = getDatabase().prepare(
    "SELECT service_id FROM managed_skill_service_operation WHERE id = ? AND workspace_id = 'default'",
  ).get(provisionOpId) as { service_id: string } | undefined;
  assert.ok(op?.service_id, "provision op must reference a service instance");
  getDatabase().prepare("UPDATE managed_skill_service SET status = 'ready' WHERE id = ?").run(op.service_id);

  // Cancel after the container is provisioned.
  const cancelled = cancelCapabilityRequestSync({
    requestId: submitted.capabilityRequest.id,
    workspaceId: "default",
    actorUserId: testUserId,
  });
  assert.equal(cancelled?.status, "cancelled");

  // The explicit retire must be queued for the provisioned container (compensation).
  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: op.service_id, limit: 20 });
  assert.ok(ops.some((o) => o.operation === "retire"), "cancel must queue an explicit retire for the provisioned container");
  // The provision op is cancelled (fenced) — a late daemon completion cannot flip it back.
  assert.equal(ops.find((o) => o.id === provisionOpId)?.status, "cancelled");
});
