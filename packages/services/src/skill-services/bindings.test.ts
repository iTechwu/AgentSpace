import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  claimNextManagedSkillServiceOperationForRuntimeSync,
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  createSkillServiceBindingSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceBindingsForServiceSync,
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
  upgradeManagedSkillServiceSync,
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

/** Distinct slug per rollback class so the immutable catalog first-write is not poisoned across tests. */
function seedCatalogWithRollback(slug: string, rollbackClass: string): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    rollbackClass,
  }).id;
}

function seedRendererCatalog(): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: CATALOG_SLUG,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    templateDigest: `sha256:${"b".repeat(64)}`,
    sbomDigest: `sha256:${"c".repeat(64)}`,
    runAsNonRoot: true,
    readOnlyRootfs: true,
    capDropJson: JSON.stringify(["NET_ADMIN"]),
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
    claimGeneration: claimed.claimGeneration,
    endpointRef: "runtime-private://renderer",
  });
  assert.equal(completed.ok, true);
  assert.equal(
    listSkillServiceBindingsSync(secondInstallation)[0]?.endpointRef,
    "runtime-private://renderer",
    "the single provision completion resolves every waiting installation binding",
  );

  const thirdInstallation = createMinimalInstallation(runtimeId);
  const third = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId: thirdInstallation,
    catalogSlug: CATALOG_SLUG,
    templateVersion: "1.0.0",
  });
  assert.equal(third.serviceId, first.serviceId, "still the same reusable instance");
  assert.equal(third.queued, false, "a ready instance is reused without another provision operation");
  assert.equal(listSkillServiceBindingsSync(thirdInstallation)[0]?.endpointRef, "runtime-private://renderer");
  assert.equal(listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: first.serviceId }).length, 1);
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
  assert.equal(claimed.catalog.runAsNonRoot, true);
  assert.equal(claimed.catalog.readOnlyRootfs, true);
  assert.deepEqual(claimed.catalog.capDrop, ["NET_ADMIN"]);
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
    claimGeneration: 0,
    endpointRef: "https://public.example.com/service",
  });
  assert.equal(badEndpoint.ok, false);
  assert.equal(badEndpoint.ok === false && badEndpoint.code, "invalid_endpoint");

  const unknown = completeManagedSkillServiceProvisionOperationSync({
    operationId: `svc-op-${randomLikeId()}`,
    workspaceId: "default",
    claimGeneration: 1,
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
    claimGeneration: claimed.claimGeneration,
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
  assert.equal(bindings[0]!.catalogTemplateVersion, "1.0.0");
  assert.equal(bindings[0]!.serviceImageDigest, `sha256:${"a".repeat(64)}`);

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
    claimGeneration: 0,
    endpointRef: "runtime-private://renderer",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "not_completable");

  const serviceStillProvisioning = readManagedSkillServiceSync(serviceId, "default");
  assert.equal(serviceStillProvisioning?.status, "provisioning");
  const waitingBinding = listSkillServiceBindingsSync(installationId);
  assert.equal(waitingBinding.length, 1);
  assert.equal(waitingBinding[0]?.endpointRef, "", "an unclaimed operation cannot publish a live endpoint");
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
    claimGeneration: provisionClaimed.claimGeneration,
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

  const retired = completeManagedSkillServiceRetireOperationSync({
    operationId: retireClaimed.id,
    workspaceId: "default",
    claimGeneration: retireClaimed.claimGeneration,
  });
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
  const done = completeManagedSkillServiceRetireOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
  });
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

test("sweep honors the backward_compatible cooldown before retiring", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedCatalogWithRollback("compat-renderer", "backward_compatible");
  const service = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "ready" });

  // First pass: record unreferenced_since, do not retire.
  const first = retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:00:00Z"),
    cooldownMs: 60_000,
  });
  assert.deepEqual(first, []);
  assert.ok(readManagedSkillServiceSync(service.id, "default")?.unreferencedSince);
  assert.equal(listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: service.id }).length, 0);

  // Inside the cooldown window: still no retire (rollback could re-bind).
  const inside = retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:00:30Z"),
    cooldownMs: 60_000,
  });
  assert.deepEqual(inside, []);

  // After the window elapses: retire is queued.
  const after = retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:01:01Z"),
    cooldownMs: 60_000,
  });
  assert.deepEqual(after, [service.id]);
  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.operation, "retire");
});

test("sweep never auto-retires an irreversible_migration service", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedCatalogWithRollback("irreversible-renderer", "irreversible_migration");
  const service = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "ready" });

  const retired = retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:00:00Z"),
    cooldownMs: 0,
  });
  assert.deepEqual(retired, []);
  assert.equal(listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: service.id }).length, 0);
  assert.equal(
    readManagedSkillServiceSync(service.id, "default")?.unreferencedSince,
    undefined,
    "irreversible services are never marked for cooldown",
  );
});

test("sweep resets the cooldown when a backward_compatible service is re-referenced", async () => {
  const runtimeId = createTestRuntime();
  const catalogId = seedCatalogWithRollback("compat-reref", "backward_compatible");
  const service = createManagedSkillServiceSync({ workspaceId: "default", runtimeId, catalogId, status: "ready" });

  retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:00:00Z"),
    cooldownMs: 60_000,
  });
  assert.ok(readManagedSkillServiceSync(service.id, "default")?.unreferencedSince);

  // Re-bind → the window resets so a rollback is not torn down.
  const installationId = createMinimalInstallation(runtimeId);
  createSkillServiceBindingSync({
    installationId,
    serviceId: service.id,
    catalogTemplateVersion: "1.0.0",
    serviceImageDigest: `sha256:${"a".repeat(64)}`,
    endpointRef: "runtime-private://compat-reref",
  });
  retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:00:10Z"),
    cooldownMs: 60_000,
  });
  assert.equal(readManagedSkillServiceSync(service.id, "default")?.unreferencedSince, undefined);
});

/* ------------------------------------------------------------------ */
/* Canary upgrade orchestration                                        */
/* ------------------------------------------------------------------ */

const CANARY_SLUG = "canary-renderer";

/** Distinct slug per test so the immutable catalog first-write is not reused. */
function seedCanaryCatalogs(rollbackClass: string, slug = CANARY_SLUG): { greenCatalogId: string; blueCatalogId: string } {
  return {
    greenCatalogId: upsertSkillServiceCatalogSync({
      workspaceId: "default",
      slug,
      templateVersion: "1.0.0",
      deploymentType: "managed_service",
      imageDigest: `sha256:${"1".repeat(64)}`,
      templateDigest: `sha256:${"2".repeat(64)}`,
      sbomDigest: `sha256:${"3".repeat(64)}`,
      networkJson: JSON.stringify({ egressAllowlist: [] }),
      configSchemaVersion: 3,
      rollbackClass,
    }).id,
    blueCatalogId: upsertSkillServiceCatalogSync({
      workspaceId: "default",
      slug,
      templateVersion: "2.0.0",
      deploymentType: "managed_service",
      imageDigest: `sha256:${"4".repeat(64)}`,
      templateDigest: `sha256:${"5".repeat(64)}`,
      sbomDigest: `sha256:${"6".repeat(64)}`,
      networkJson: JSON.stringify({ egressAllowlist: [] }),
      configSchemaVersion: 4,
      rollbackClass,
    }).id,
  };
}

/** Plans an installation against the green (1.0.0) catalog and provisions it to ready. */
async function provisionGreenToReady(runtimeId: string, salt: string, slug = CANARY_SLUG) {
  const artifact = buildAndPersistSkillArtifactSync({
    name: `Canary ${salt}`,
    files: [{ path: "SKILL.md", bytes: encoder.encode(`# ${salt}\n`) }],
    services: [{ catalogSlug: slug, templateVersion: "1.0.0", required: true }],
  });
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest: artifact.digest });
  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  assert.equal(claimed.operation, "provision");
  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    endpointRef: "runtime-private://canary-v1",
  });
  assert.equal(completed.ok, true);
  assert.equal(readSkillInstallationSync(installation.id, "default")?.status, "ready");
  return { serviceId: claimed.serviceId, installation };
}

test("upgrade refuses unknown/retired/provisioning services, wrong lineage, same version, and no bindings", async () => {
  const { greenCatalogId } = seedCanaryCatalogs("stateless");

  const missing = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: `svc-${randomLikeId()}`,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.code, "service_not_found");

  // createManagedSkillServiceSync dedupes on (workspace, runtime, catalog) — each
  // service below needs its OWN runtime so they are distinct rows.
  const retiredRuntime = createTestRuntime();
  const realRetired = createManagedSkillServiceSync({
    workspaceId: "default", runtimeId: retiredRuntime, catalogId: greenCatalogId, status: "retired",
  });
  const retiredResult = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: realRetired.id,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(retiredResult.ok, false);
  assert.equal(retiredResult.ok === false && retiredResult.code, "already_retired");

  const provisioningRuntime = createTestRuntime();
  const provisioning = createManagedSkillServiceSync({
    workspaceId: "default", runtimeId: provisioningRuntime, catalogId: greenCatalogId, status: "provisioning",
  });
  const provisioningResult = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: provisioning.id,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(provisioningResult.ok, false);
  assert.equal(provisioningResult.ok === false && provisioningResult.code, "still_provisioning");

  const noBindingsRuntime = createTestRuntime();
  const noBindings = createManagedSkillServiceSync({
    workspaceId: "default", runtimeId: noBindingsRuntime, catalogId: greenCatalogId, status: "ready",
  });
  const noBindingsResult = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: noBindings.id,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(noBindingsResult.ok, false);
  assert.equal(noBindingsResult.ok === false && noBindingsResult.code, "no_bindings");

  // Same version is a no-op upgrade.
  const installationId = createMinimalInstallation(noBindingsRuntime);
  createSkillServiceBindingSync({
    installationId,
    serviceId: noBindings.id,
    catalogTemplateVersion: "1.0.0",
    serviceImageDigest: `sha256:${"1".repeat(64)}`,
    endpointRef: "runtime-private://canary-v1",
  });
  const sameVersion = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: noBindings.id,
    catalogSlug: CANARY_SLUG,
    templateVersion: "1.0.0",
  });
  assert.equal(sameVersion.ok, false);
  assert.equal(sameVersion.ok === false && sameVersion.code, "already_current");

  // Wrong lineage (different slug).
  upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "other-renderer",
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"9".repeat(64)}`,
  });
  const wrongLineage = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: noBindings.id,
    catalogSlug: "other-renderer",
    templateVersion: "1.0.0",
  });
  assert.equal(wrongLineage.ok, false);
  assert.equal(wrongLineage.ok === false && wrongLineage.code, "catalog_lineage_mismatch");
});

test("upgrade provisions a blue instance on the same runtime recording the replaced service", async () => {
  seedCanaryCatalogs("stateless");
  const runtimeId = createTestRuntime();
  const green = await provisionGreenToReady(runtimeId, "upgrade-a");

  const result = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: green.serviceId,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok === false ? "" : result.queued, true);
  if (!result.ok) {
    return;
  }

  const blue = readManagedSkillServiceSync(result.blueServiceId, "default");
  assert.ok(blue);
  assert.equal(blue.status, "provisioning");
  assert.equal(blue.runtimeId, runtimeId, "blue must stay on the SAME runtime");
  assert.notEqual(blue.id, green.serviceId);

  const ops = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: result.blueServiceId });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.operation, "provision");
  assert.equal(ops[0]!.replacesServiceId, green.serviceId, "canary op must record which service it replaces");
});

test("upgrade dedupes: re-running reuses the blue instance without stacking an active provision", async () => {
  seedCanaryCatalogs("stateless");
  const runtimeId = createTestRuntime();
  const green = await provisionGreenToReady(runtimeId, "upgrade-b");

  const first = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: green.serviceId,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(first.ok, true);
  const second = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: green.serviceId,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(second.blueServiceId, first.blueServiceId, "instance must be reused");
    assert.equal(second.queued, false, "active provision must not be duplicated");
  }
  const activeOps = first.ok
    ? listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: first.blueServiceId })
        .filter((op) => ["pending", "claimed", "running"].includes(op.status))
    : [];
  assert.equal(activeOps.length, 1);
});

test("canary complete switches bindings to blue (blue-green) and green becomes unreferenced", async () => {
  seedCanaryCatalogs("stateless");
  const runtimeId = createTestRuntime();
  const green = await provisionGreenToReady(runtimeId, "upgrade-c");
  assert.equal(listSkillServiceBindingsForServiceSync(green.serviceId).length, 1);

  const upgrade = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: green.serviceId,
    catalogSlug: CANARY_SLUG,
    templateVersion: "2.0.0",
  });
  assert.equal(upgrade.ok, true);
  if (!upgrade.ok) {
    return;
  }

  // Claim the BLUE provision and report it healthy with the new endpoint.
  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  assert.equal(claimed.serviceId, upgrade.blueServiceId);
  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    endpointRef: "runtime-private://canary-v2",
    healthRevision: "7",
  });
  assert.equal(completed.ok, true);

  // The binding moved green → blue and was re-stamped with the BLUE catalog.
  const binding = listSkillServiceBindingsSync(green.installation.id);
  assert.equal(binding.length, 1);
  assert.equal(binding[0]!.serviceId, upgrade.blueServiceId);
  assert.equal(binding[0]!.endpointRef, "runtime-private://canary-v2");
  assert.equal(binding[0]!.healthRevision, "7");
  assert.equal(binding[0]!.catalogTemplateVersion, "2.0.0");
  assert.equal(binding[0]!.serviceImageDigest, `sha256:${"4".repeat(64)}`);
  assert.equal(binding[0]!.configSchemaVersion, 4);

  // Blue is ready; the installation stays ready through the switch.
  assert.equal(readManagedSkillServiceSync(upgrade.blueServiceId, "default")?.status, "ready");
  assert.equal(readSkillInstallationSync(green.installation.id, "default")?.status, "ready");

  // Green now has no bindings → the (stateless) sweep queues its retire.
  assert.equal(listSkillServiceBindingsForServiceSync(green.serviceId).length, 0);
  const retired = retireUnreferencedManagedSkillServicesSync({ workspaceId: "default" });
  assert.ok(retired.includes(green.serviceId));
});

test("canary green is kept for the backward_compatible cooldown window, then retired", async () => {
  const compatSlug = "canary-compat";
  seedCanaryCatalogs("backward_compatible", compatSlug);
  const runtimeId = createTestRuntime();
  const green = await provisionGreenToReady(runtimeId, "upgrade-d", compatSlug);

  const upgrade = upgradeManagedSkillServiceSync({
    workspaceId: "default",
    serviceId: green.serviceId,
    catalogSlug: compatSlug,
    templateVersion: "2.0.0",
  });
  assert.equal(upgrade.ok, true);
  if (!upgrade.ok) {
    return;
  }
  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    endpointRef: "runtime-private://canary-v2",
  });
  assert.equal(completed.ok, true);

  // Rollback window: green is unreferenced but NOT retired on the first pass.
  const first = retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-02-01T00:00:00Z"),
    cooldownMs: 60_000,
  });
  assert.deepEqual(first, []);
  assert.ok(readManagedSkillServiceSync(green.serviceId, "default")?.unreferencedSince);
  assert.equal(
    listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: green.serviceId })
      .some((op) => op.operation === "retire"),
    false,
  );

  // After the window elapses the sweep queues the green retire.
  const after = retireUnreferencedManagedSkillServicesSync({
    workspaceId: "default",
    now: new Date("2026-02-01T00:01:01Z"),
    cooldownMs: 60_000,
  });
  assert.deepEqual(after, [green.serviceId]);
});

/* ------------------------------------------------------------------ */
/* Cosign signature claim payload (schema v82)                         */
/* ------------------------------------------------------------------ */

const SIGNATURE_PUB_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFqpQUB2kqJXqZq9Y0Jq0N6nRqZb6
vY1Q6GZPZ5aB0nR4Lz1S8u4jT2qVwzKQm0xEb7jHkY9x0o0I9sM0w==
-----END PUBLIC KEY-----`;

test("claim payload carries the cosign signature trust anchor when the catalog enforces it", () => {
  const runtimeId = createTestRuntime();
  const catalogId = upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "sig-renderer",
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"7".repeat(64)}`,
    templateDigest: `sha256:${"8".repeat(64)}`,
    sbomDigest: `sha256:${"9".repeat(64)}`,
    networkJson: JSON.stringify({ egressAllowlist: [] }),
    signatureKeyPem: SIGNATURE_PUB_KEY_PEM,
    signatureRequired: true,
  }).id;
  const installationId = createMinimalInstallation(runtimeId);
  const { serviceId } = queueManagedSkillServiceForInstallationSync({
    workspaceId: "default",
    runtimeId,
    installationId,
    catalogSlug: "sig-renderer",
    templateVersion: "1.0.0",
  });

  const op = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId })[0]!;
  const claimed = resolveClaimedManagedSkillServiceOperation(op);

  assert.ok(claimed);
  assert.equal(claimed.catalog.signatureKeyPem, SIGNATURE_PUB_KEY_PEM);
  assert.equal(claimed.catalog.signatureRequired, true);
  assert.equal(catalogId.length > 0, true);
});
