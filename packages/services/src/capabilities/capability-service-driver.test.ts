import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  createCapabilityRequestSync,
  createUserSync,
  getDatabase,
  listManagedSkillServiceOperationsSync,
  randomLikeId,
  readCapabilityRequestSync,
  readManagedSkillServiceSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import { resetWorkspaceStateSync, retireUnreferencedManagedSkillServicesSync } from "../index.ts";
import {
  convergeCapabilityRequestFromSkillServiceOperationSync,
  queueCapabilityManagedServiceProvisionSync,
} from "./capability-service-driver.ts";

/**
 * Managed-service container driver (docs/0811/cli-install Phase 5). These tests
 * are DB-backed like the rest of packages/* node:test — they require the shared
 * test Postgres and run in CI where the schema is current.
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
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `Test Runtime ${id}`, now, now);
  return id;
}

function seedManagedServiceTemplate(slug: string): string {
  return seedManagedServiceTemplateVersion(slug, "1.0.0");
}

function seedManagedServiceTemplateVersion(slug: string, templateVersion: string): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug,
    templateVersion,
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

function createApprovedServiceRequest(runtimeId: string, slug: string) {
  return createCapabilityRequestSync({
    workspaceId: "default",
    requestedByUserId: testUserId,
    runtimeId,
    packageKind: "service",
    packageSource: "official",
    packageSlug: slug,
    packageDisplayName: "Managed Test Service",
    deploymentMode: "managed_service",
    requestedAction: "deploy",
    metadataJson: "{}",
  }).record;
}

test("queueCapabilityManagedServiceProvisionSync creates a service instance + provision operation", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  const request = createApprovedServiceRequest(runtimeId, slug);

  const queued = queueCapabilityManagedServiceProvisionSync({
    workspaceId: "default",
    request,
  });

  assert.equal(queued.queued, true);
  assert.ok(queued.operationId, "provision operation must be created");
  const service = readManagedSkillServiceSync(queued.serviceId!, "default");
  assert.ok(service, "managed service instance must exist");
  assert.equal(service.runtimeId, runtimeId);

  const operations = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: service.id, limit: 10 });
  assert.equal(operations.some((op) => op.id === queued.operationId && op.operation === "provision"), true);

  // The request transitions to running and records the operation linkage.
  const updated = readCapabilityRequestSync(request.id, "default");
  assert.equal(updated?.status, "running");
  const metadata = JSON.parse(updated?.metadataJson ?? "{}") as Record<string, unknown>;
  assert.equal(metadata.skillServiceOperationId, queued.operationId);
});

test("queueCapabilityManagedServiceProvisionSync is idempotent per (runtime, catalog) and reuses the in-flight operation", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  const first = createApprovedServiceRequest(runtimeId, slug);
  const firstQueued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request: first });

  const second = createApprovedServiceRequest(runtimeId, slug);
  const secondQueued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request: second });

  assert.equal(firstQueued.queued, true);
  assert.equal(secondQueued.queued, true);
  assert.equal(firstQueued.serviceId, secondQueued.serviceId, "re-plan must reuse the same instance");
  assert.equal(firstQueued.operationId, secondQueued.operationId, "re-plan must reuse the in-flight operation");
  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: firstQueued.serviceId!, limit: 20 });
  assert.equal(ops.filter((op) => op.operation === "provision").length, 1, "no duplicate provision operations");
});

test("queueCapabilityManagedServiceProvisionSync fails closed when no template is admitted", () => {
  const runtimeId = createTestRuntime();
  const request = createApprovedServiceRequest(runtimeId, `not-admitted-${randomLikeId()}`);
  const queued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(queued.queued, false);
  assert.equal(queued.code, "template_not_admitted");
});

test("queueCapabilityManagedServiceProvisionSync does NOT re-provision an already-ready instance", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  const templateId = seedManagedServiceTemplate(slug);
  const request = createApprovedServiceRequest(runtimeId, slug);
  const first = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(first.code, "provision_queued");

  // Mark the instance ready (as the daemon does after a successful provision).
  getDatabase().prepare(
    "UPDATE managed_skill_service SET status = 'ready' WHERE id = ?",
  ).run(first.serviceId!);

  const again = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(again.code, "service_ready", "ready instance must not be re-provisioned");
  assert.equal(again.queued, false);
  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: first.serviceId!, limit: 20 });
  assert.equal(ops.filter((op) => op.operation === "provision").length, 1, "no duplicate provision operations");
});

test("queueCapabilityManagedServiceProvisionSync uses the PINNED template id, not the latest by slug", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  // Two templates, same slug; the pinned one is the OLDER version.
  const oldTemplateId = seedManagedServiceTemplate(slug); // version 1.0.0
  seedManagedServiceTemplateVersion(slug, "2.0.0");
  // Submit pins the older template id (S2).
  const request = createApprovedServiceRequest(runtimeId, slug);
  getDatabase().prepare(
    "UPDATE capability_request SET metadata_json = ? WHERE id = ?",
  ).run(JSON.stringify({ managedServiceCatalogId: oldTemplateId }), request.id);
  const pinnedRequest = readCapabilityRequestSync(request.id, "default")!;

  const queued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request: pinnedRequest });
  assert.equal(queued.queued, true);
  const service = readManagedSkillServiceSync(queued.serviceId!, "default");
  assert.equal(service.catalogId, oldTemplateId, "dispatch must use the pinned template, not the newest by slug");
});

test("convergeCapabilityRequestFromSkillServiceOperationSync converges the request on operation completion", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  const request = createApprovedServiceRequest(runtimeId, slug);
  const queued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(queued.queued, true);

  const converged = convergeCapabilityRequestFromSkillServiceOperationSync({
    operationId: queued.operationId!,
    workspaceId: "default",
    outcome: "succeeded",
  });
  assert.equal(converged?.id, request.id);
  assert.equal(converged?.status, "completed");

  const failedRequest = createApprovedServiceRequest(runtimeId, slug);
  const failedQueued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request: failedRequest });
  const failed = convergeCapabilityRequestFromSkillServiceOperationSync({
    operationId: failedQueued.operationId!,
    workspaceId: "default",
    outcome: "failed",
    errorCode: "skill_service.provision_failed",
    errorMessage: "container failed",
  });
  assert.equal(failed?.id, failedRequest.id);
  assert.equal(failed?.status, "failed");
});

test("queueCapabilityManagedServiceProvisionSync stores the mcpAutoConnect marker for managed MCP dispatch", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  const request = createApprovedServiceRequest(runtimeId, slug);
  const queued = queueCapabilityManagedServiceProvisionSync({
    workspaceId: "default",
    request,
    mcpAutoConnect: {
      actorUserId: testUserId,
      catalogItemId: "mcp-catalog-1",
      endpoint: "stdio://test-mcp",
      approvedTools: ["search"],
    },
  });
  assert.equal(queued.code, "provision_queued");
  const updated = readCapabilityRequestSync(request.id, "default");
  const metadata = JSON.parse(updated?.metadataJson ?? "{}") as Record<string, unknown>;
  assert.equal(metadata.skillServiceOperationId, queued.operationId);
  assert.ok(metadata.mcpAutoConnect, "auto-connect marker must be persisted");
  const marker = metadata.mcpAutoConnect as Record<string, unknown>;
  assert.equal(marker.catalogItemId, "mcp-catalog-1");
  assert.equal(updated?.status, "running");
});

test("convergeCapabilityRequestFromSkillServiceOperationSync fails a managed MCP closed when auto-connect cannot materialize", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  const request = createApprovedServiceRequest(runtimeId, slug);
  const queued = queueCapabilityManagedServiceProvisionSync({
    workspaceId: "default",
    request,
    // Marker references a catalog item that does not exist → auto-connect fails closed.
    mcpAutoConnect: {
      actorUserId: testUserId,
      catalogItemId: "mcp-missing",
      endpoint: "stdio://test-mcp",
      approvedTools: [],
    },
  });
  assert.equal(queued.code, "provision_queued");

  const converged = convergeCapabilityRequestFromSkillServiceOperationSync({
    operationId: queued.operationId!,
    workspaceId: "default",
    outcome: "succeeded",
  });
  assert.equal(converged?.id, request.id);
  assert.equal(converged?.status, "failed", "missing MCP catalog must fail closed, not stay running");
  assert.equal(converged?.lastErrorCode, "mcp.connection_dispatch_failed");
});

test("retire sweep does not retire a service backed by a completed capability, but retires a cancelled one", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  const templateId = seedManagedServiceTemplate(slug);
  const request = createApprovedServiceRequest(runtimeId, slug);
  const queued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(queued.code, "provision_queued");
  getDatabase().prepare("UPDATE managed_skill_service SET status = 'ready' WHERE id = ?").run(queued.serviceId!);

  // A completed capability still backs the service (live deployment) → protected.
  const completed = readCapabilityRequestSync(request.id, "default")!;
  getDatabase().prepare(
    "UPDATE capability_request SET status = 'completed', metadata_json = ? WHERE id = ?",
  ).run(JSON.stringify({ managedServiceCatalogId: templateId, serviceId: queued.serviceId }), completed.id);

  const sweptWithCompleted = retireUnreferencedManagedSkillServicesSync({ workspaceId: "default" });
  assert.ok(!sweptWithCompleted.includes(queued.serviceId!), "completed capability service must not be swept");

  // A cancelled capability releases the service → swept. Use a distinct slug so
  // a separate service instance is created (createManagedSkillServiceSync is
  // idempotent per workspace+runtime+catalog).
  const slug2 = `driver-${randomLikeId()}`;
  const template2Id = seedManagedServiceTemplate(slug2);
  const request2 = createApprovedServiceRequest(runtimeId, slug2);
  const queued2 = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request: request2 });
  assert.notEqual(queued2.serviceId, queued.serviceId);
  getDatabase().prepare("UPDATE managed_skill_service SET status = 'ready' WHERE id = ?").run(queued2.serviceId!);
  getDatabase().prepare(
    "UPDATE capability_request SET status = 'cancelled', metadata_json = ? WHERE id = ?",
  ).run(JSON.stringify({ managedServiceCatalogId: template2Id, serviceId: queued2.serviceId }), request2.id);

  const sweptWithCancelled = retireUnreferencedManagedSkillServicesSync({ workspaceId: "default" });
  assert.ok(!sweptWithCancelled.includes(queued.serviceId!), "completed capability service stays protected");
  assert.ok(sweptWithCancelled.includes(queued2.serviceId!), "cancelled capability service should be retired");
});

test("converge returns a credential-bearing managed MCP to approved (not completed) after container provision", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  seedManagedServiceTemplate(slug);
  // mcp-kind managed_service request WITHOUT an auto-connect marker (credential /
  // endpoint-bearing) — the container is provisioned but the applicant must
  // still finish the connection, so the request returns to approved.
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
    metadataJson: "{}",
  }).record;
  const queued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(queued.code, "provision_queued");

  const converged = convergeCapabilityRequestFromSkillServiceOperationSync({
    operationId: queued.operationId!,
    workspaceId: "default",
    outcome: "succeeded",
    endpointRef: "runtime-private://svc-abc",
  });
  assert.equal(converged?.id, request.id);
  assert.equal(converged?.status, "approved", "credential managed MCP must await configure_credentials, not auto-complete");
  // The daemon's container endpoint must be persisted for server-side resolution
  // on completion — the browser never re-submits the private endpoint (Spec P0).
  const stored = JSON.parse(converged?.metadataJson ?? "{}") as Record<string, unknown>;
  assert.equal(stored.provisionedEndpointRef, "runtime-private://svc-abc", "provisionedEndpointRef must be persisted for the completion path");
});

test("a signature-required template without a trusted key fails closed at dispatch", () => {
  const runtimeId = createTestRuntime();
  const slug = `driver-${randomLikeId()}`;
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    templateDigest: `sha256:${"b".repeat(64)}`,
    protocol: "http",
    networkJson: JSON.stringify({ ingress: "private" }),
    healthJson: JSON.stringify({ path: "/healthz" }),
    resourcesJson: JSON.stringify({ cpu: "250m", memory: "128Mi" }),
    signatureRequired: true, // requires verification, but no signatureKeyPem
  });
  const request = createApprovedServiceRequest(runtimeId, slug);
  const queued = queueCapabilityManagedServiceProvisionSync({ workspaceId: "default", request });
  assert.equal(queued.queued, false);
  assert.equal(queued.code, "template_not_admitted", "unverifiable image must not be provisioned");
});
