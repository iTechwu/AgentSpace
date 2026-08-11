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
import { resetWorkspaceStateSync } from "../index.ts";
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
  assert.equal(queued.code, "capability_request.managed_service_template_not_admitted");
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
