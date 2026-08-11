import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  createCapabilityRequestSync,
  createUserSync,
  createWorkspaceMembershipSync,
  decideCapabilityRequestSync,
  getDatabase,
  listManagedSkillServiceOperationsSync,
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
} from "./capability-workflow.ts";

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

test("baseline npm/python plans fail closed without a configured pinned artifact", () => {
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_INTEGRITY;
  delete process.env.DOFE_AGENT_BASELINE_PYTHON_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_PYTHON_ARTIFACT_INTEGRITY;
  assert.equal(buildRuntimeBaselineInstallPlan("npm"), null, "image-level npm must fail closed unless pinned");
  assert.equal(buildRuntimeBaselineInstallPlan("python"), null);
});

test("baseline npm plan uses a pinned verified artifact when ops configures one", () => {
  process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL = "https://nodejs.org/dist/v20.0.0/node-v20.0.0-darwin-x64.tar.gz";
  process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_INTEGRITY = `sha256-${"a".repeat(64)}`;
  const plan = buildRuntimeBaselineInstallPlan("npm");
  assert.ok(plan, "configured pin must produce a plan");
  assert.equal(plan.artifactLock?.url, "https://nodejs.org/dist/v20.0.0/node-v20.0.0-darwin-x64.tar.gz");
  assert.equal(plan.artifactLock?.integrity, `sha256-${"a".repeat(64)}`);
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_URL;
  delete process.env.DOFE_AGENT_BASELINE_NODE_ARTIFACT_INTEGRITY;
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
  assert.ok(depOp?.appName.startsWith("mcp-dependency:"), "dependency CLI install must be queued before connecting");
});
