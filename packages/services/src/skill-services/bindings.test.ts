import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  claimNextManagedSkillServiceOperationForRuntimeSync,
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  createSkillServiceBindingSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceBindingsSync,
  readManagedSkillServiceSync,
  readSkillInstallationSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  completeManagedSkillServiceProvisionOperationSync,
  completeManagedSkillServiceRetireOperationSync,
  createSkillInstallationPlanSync,
  queueManagedSkillServiceForInstallationSync,
  queueManagedSkillServiceRetireSync,
  resetWorkspaceStateSync,
  resolveClaimedManagedSkillServiceOperation,
  retireUnreferencedManagedSkillServicesSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const encoder = new TextEncoder();
const testTosStorage = createTestTosAttachmentStorage();

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage.client);
});

beforeEach(() => {
  resetWorkspaceStateSync();
  testTosStorage.clear();
});

after(() => {
  testTosStorage.clear();
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

const CATALOG_SLUG = "bindings-renderer";

function seedRendererCatalog(): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: CATALOG_SLUG,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    protocol: "http",
    networkJson: JSON.stringify({ ingress: "private" }),
    healthJson: JSON.stringify({ path: "/healthz" }),
    resourcesJson: JSON.stringify({ cpu: "250m", memory: "128Mi" }),
  }).id;
}

/** Minimal skill_installation row so a queued operation's FK resolves. */
function createMinimalInstallation(runtimeId: string): string {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO skill_artifact (id, workspace_id, digest, name, version, manifest_version, manifest_json, source_type, provenance_json, file_count, total_size_bytes, legacy_incomplete, created_at)
     VALUES (?, 'default', ?, 'test', '1.0', 1, '{}', 'manual', '{}', 0, 0, 0, ?)`,
  ).run(`art-${randomLikeId()}`, `digest-${randomLikeId()}`, now);
  const installationId = `inst-${randomLikeId()}`;
  const digest = (getDatabase().prepare(
    `SELECT digest FROM skill_artifact WHERE workspace_id = 'default' ORDER BY created_at DESC LIMIT 1`,
  ).get() as { digest: string }).digest;
  getDatabase().prepare(
    `INSERT INTO skill_installation (id, workspace_id, runtime_id, artifact_digest, status, resolved_lock_json, health, revision, created_at, updated_at)
     VALUES (?, 'default', ?, ?, 'preparing', '{}', 'unknown', 'v1', ?, ?)`,
  ).run(installationId, runtimeId, digest, now, now);
  return installationId;
}

/* ------------------------------------------------------------------ */
/* queueManagedSkillServiceForInstallationSync                         */
/* ------------------------------------------------------------------ */

test("queue creates a managed service + provision operation recording the installation", () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const installationId = createMinimalInstallation(runtimeId);

  const result = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  assert.equal(result.queued, true);

  const managed = readManagedSkillServiceSync(result.serviceId, "default");
  assert.ok(managed);
  assert.equal(managed.status, "provisioning");
  assert.equal(managed.runtimeId, runtimeId);

  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: result.serviceId });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.operation, "provision");
  assert.equal(ops[0]!.installationId, installationId);
});

test("queue throws when the catalog entry does not exist", () => {
  const runtimeId = createTestRuntime();
  const installationId = createMinimalInstallation(runtimeId);

  assert.throws(
    () =>
      queueManagedSkillServiceForInstallationSync({
        workspaceId: "default",
        runtimeId,
        installationId,
        catalogSlug: "no-such-renderer",
        templateVersion: "1.0.0",
      }),
    /does not exist/,
  );
});

test("queue dedupes: re-plan for the same runtime+catalog reuses the instance and does not stack an active operation", () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const firstInstallation = createMinimalInstallation(runtimeId);
  const secondInstallation = createMinimalInstallation(runtimeId);

  const first = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId: firstInstallation,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  assert.equal(first.queued, true);

  // Re-plan while the first provision is still active: same instance, no new op.
  const second = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId: secondInstallation,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  assert.equal(second.serviceId, first.serviceId, "instance must be reused");
  assert.equal(second.queued, false, "active provision op must not be duplicated");

  const activeOps = listManagedSkillServiceOperationsSync({
    workspaceId: "default",
    serviceId: first.serviceId,
  }).filter((op) => ["pending", "claimed", "running"].includes(op.status));
  assert.equal(activeOps.length, 1);

  // Claim + complete the active op, then a fresh plan queues a new one.
  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    endpointRef: "runtime-private://renderer",
  });
  assert.equal(completed.ok, true);

  const thirdInstallation = createMinimalInstallation(runtimeId);
  const third = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId: thirdInstallation,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  assert.equal(third.serviceId, first.serviceId, "still the same reusable instance");
  assert.equal(third.queued, true, "after completion a new provision op is queued");
});

/* ------------------------------------------------------------------ */
/* resolveClaimedManagedSkillServiceOperation                          */
/* ------------------------------------------------------------------ */

test("resolve builds the one-time claim payload with catalog fields", () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const installationId = createMinimalInstallation(runtimeId);
  const { serviceId } = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });

  const op = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId })[0]!;
  const claimed = resolveClaimedManagedSkillServiceOperation(op);

  assert.ok(claimed);
  assert.equal(claimed.operationId, op.id);
  assert.equal(claimed.serviceId, serviceId);
  assert.equal(claimed.installationId, installationId);
  assert.equal(claimed.operation, "provision");
  assert.equal(claimed.catalog.imageDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(claimed.catalog.protocol, "http");
  assert.deepEqual(JSON.parse(claimed.catalog.networkJson!), { ingress: "private" });
  assert.deepEqual(JSON.parse(claimed.catalog.healthJson!), { path: "/healthz" });
  assert.deepEqual(JSON.parse(claimed.catalog.resourcesJson!), { cpu: "250m", memory: "128Mi" });
});

test("resolve returns null when the managed service row is gone", () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const installationId = createMinimalInstallation(runtimeId);
  const { serviceId } = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  const op = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId })[0]!;

  getDatabase().prepare("DELETE FROM managed_skill_service WHERE id = ?").run(serviceId);
  assert.equal(resolveClaimedManagedSkillServiceOperation(op), null);
});

/* ------------------------------------------------------------------ */
/* completeManagedSkillServiceProvisionOperationSync                   */
/* ------------------------------------------------------------------ */

test("complete rejects a non-runtime-private endpoint and unknown operation", () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const installationId = createMinimalInstallation(runtimeId);
  const { serviceId } = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  const op = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId })[0]!;

  const badEndpoint = completeManagedSkillServiceProvisionOperationSync({
    operationId: op.id,
    workspaceId: "default",
    endpointRef: "https://public.example.com/service",
  });
  assert.equal(badEndpoint.ok, false);
  assert.equal(badEndpoint.ok === false && badEndpoint.code, "invalid_endpoint");

  const unknown = completeManagedSkillServiceProvisionOperationSync({
    operationId: `svc-op-${randomLikeId()}`,
    workspaceId: "default",
    endpointRef: "runtime-private://renderer",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.code, "operation_not_found");
});

test("complete marks the service ready, creates the binding, and the installation reaches ready", async () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();

  // End-to-end: plan creation queues the provision operation itself.
  const artifact = buildAndPersistSkillArtifactSync({
    name: "Service Skill",
    files: [{ path: "SKILL.md", bytes: encoder.encode("# Body\n") }],
    services: [{ catalogSlug: CATALOG_SLUG, templateVersion: "1.0.0", required: true }],
  });
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });

  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", runtimeId });
  assert.equal(ops.length, 1, "plan must queue one provision operation");

  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);

  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    endpointRef: "runtime-private://bindings-renderer",
    healthRevision: "2",
  });
  assert.equal(completed.ok, true);

  const managed = readManagedSkillServiceSync(claimed.serviceId, "default");
  assert.equal(managed?.status, "ready");

  const bindings = listSkillServiceBindingsSync(installation.id);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.serviceId, claimed.serviceId);
  assert.equal(bindings[0]!.endpointRef, "runtime-private://bindings-renderer");
  assert.equal(bindings[0]!.healthRevision, "2");

  // Provision complete re-evaluates the service component from the binding →
  // ready; with the service as the only component the installation is ready.
  assert.equal(readSkillInstallationSync(installation.id, "default")?.status, "ready");
});

test("complete fails an unclaimed operation closed", () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const installationId = createMinimalInstallation(runtimeId);
  const { serviceId } = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  const op = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId })[0]!;

  // No claim → no lease → the DB complete guard rejects.
  const result = completeManagedSkillServiceProvisionOperationSync({
    operationId: op.id,
    workspaceId: "default",
    endpointRef: "runtime-private://renderer",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "not_completable");

  const serviceStillProvisioning = readManagedSkillServiceSync(serviceId, "default");
  assert.equal(serviceStillProvisioning?.status, "provisioning");
  assert.equal(listSkillServiceBindingsSync(installationId).length, 0);
});

test("retire marks the service retired and the dependent installation goes blocked", async () => {
  const runtimeId = createTestRuntime();
  seedRendererCatalog();
  const artifact = buildAndPersistSkillArtifactSync({
    name: "Service Skill Retire",
    files: [{ path: "SKILL.md", bytes: encoder.encode("# Retire\n") }],
    services: [{ catalogSlug: CATALOG_SLUG, templateVersion: "1.0.0", required: true }],
  });
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });

  // Provision to ready first (queues a provision op; complete binds it).
  const provisionClaimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(provisionClaimed);
  const provisioned = completeManagedSkillServiceProvisionOperationSync({
    operationId: provisionClaimed.id,
    workspaceId: "default",
    endpointRef: "runtime-private://bindings-renderer",
  });
  assert.equal(provisioned.ok, true);
  assert.equal(readManagedSkillServiceSync(provisionClaimed.serviceId, "default")?.status, "ready");
  assert.equal(readSkillInstallationSync(installation.id, "default")?.status, "ready");

  // Queue + claim a retire operation and complete it (no endpoint involved).
  createManagedSkillServiceOperationSync({
    workspaceId: "default",
    runtimeId,
    serviceId: provisionClaimed.serviceId,
    installationId: installation.id,
    operation: "retire",
  });
  const retireClaimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(retireClaimed);
  assert.equal(retireClaimed.operation, "retire");

  const retired = completeManagedSkillServiceRetireOperationSync({ operationId: retireClaimed.id, workspaceId: "default" });
  assert.equal(retired.ok, true);
  assert.equal(readManagedSkillServiceSync(retireClaimed.serviceId, "default")?.status, "retired");

  // The dependent installation's service component resolves blocked again.
  assert.equal(readSkillInstallationSync(installation.id, "default")?.status, "blocked");
});

/* ------------------------------------------------------------------ */
/* Retire producer + lifecycle sweep                                   */
/* ------------------------------------------------------------------ */

test("queue retire produces a retire operation for a ready service and dedupes", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedRendererCatalog();
  const service = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "ready" });

  const first = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(first.queued, true);
  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.operation, "retire");
  assert.equal(ops[0]!.status, "pending");

  const second = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(second.queued, false);
  assert.equal(second.queued === false && second.reason, "already_queued");
});

test("queue retire refuses provisioning and unknown services", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedRendererCatalog();
  const provisioning = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "provisioning" });

  const stillProvisioning = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: provisioning.id });
  assert.equal(stillProvisioning.queued, false);
  assert.equal(stillProvisioning.queued === false && stillProvisioning.reason, "still_provisioning");

  const missing = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: `svc-${randomLikeId()}` });
  assert.equal(missing.queued, false);
  assert.equal(missing.queued === false && missing.reason, "service_not_found");
});

test("queue retire after the retire completes reports already_retired", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedRendererCatalog();
  const service = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "ready" });

  const queued = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(queued.queued, true);
  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  assert.equal(claimed.operation, "retire");
  const done = completeManagedSkillServiceRetireOperationSync({ operationId: claimed.id, workspaceId: "default" });
  assert.equal(done.ok, true);
  assert.equal(readManagedSkillServiceSync(service.id, "default")?.status, "retired");

  const again = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(again.queued, false);
  assert.equal(again.queued === false && again.reason, "already_retired");
});

test("sweep retires ready services with no bindings and keeps bound services", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedRendererCatalog();
  const unbound = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "ready" });

  const boundRuntime = createTestRuntime();
  const boundService = createManagedSkillServiceSync({ workspaceId: "default", runtimeId: boundRuntime, catalogId, status: "ready" });
  const installationId = createMinimalInstallation(boundRuntime);
  createSkillServiceBindingSync({
    installationId,
    serviceId: boundService.id,
    catalogTemplateVersion: "1.0.0",
    serviceImageDigest: `sha256:${"a".repeat(64)}`,
    endpointRef: "runtime-private://bindings-renderer",
  });

  const retired = retireUnreferencedManagedSkillServicesSync({ workspaceId: "default" });
  assert.ok(retired.includes(unbound.id), "unbound ready service must be retired");
  assert.ok(!retired.includes(boundService.id), "bound service must stay up");

  const unboundOps = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: unbound.id });
  assert.equal(unboundOps.length, 1);
  assert.equal(unboundOps[0]!.operation, "retire");
  const boundOps = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: boundService.id });
  assert.equal(boundOps.length, 0);
});

test("sweep skips already-retired and still-provisioning services", async () => {
  const retiredRuntime = createTestRuntime();
  const provisioningRuntime = createTestRuntime();
  const catalogId = seedRendererCatalog();
  const retiredService = createManagedSkillServiceSync({
    workspaceId: "default", runtimeId: retiredRuntime, catalogId, status: "retired",
  });
  const provisioningService = createManagedSkillServiceSync({
    workspaceId: "default", runtimeId: provisioningRuntime, catalogId, status: "provisioning",
  });

  const retired = retireUnreferencedManagedSkillServicesSync({ workspaceId: "default" });
  assert.ok(!retired.includes(retiredService.id));
  assert.ok(!retired.includes(provisioningService.id));
});
