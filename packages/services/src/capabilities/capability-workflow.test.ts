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
  upsertMcpCatalogItemSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import { resetWorkspaceStateSync } from "../index.ts";
import {
  approveCapabilityRequestSync,
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
    endpointTemplate: "https://mcp.example.com/mcp",
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {} }),
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

test("completeCapabilityRequestMcpConnectionSync refuses to spend a non-connect approval", () => {
  const runtimeId = createTestRuntime();
  const slug = `mcp-${randomLikeId()}`;
  const catalogId = seedMcpCatalog(slug, "official");
  // A `deploy` request must not be consumable by the connect-completion path.
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
