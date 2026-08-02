import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import {
  claimNextManagedSkillServiceOperationForRuntimeSync,
  completeManagedSkillServiceOperationSync,
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  failManagedSkillServiceOperationSync,
  listManagedSkillServiceOperationsSync,
  readManagedSkillServiceOperationSync,
  renewManagedSkillServiceOperationLeaseSync,
  requeueExpiredManagedSkillServiceOperationLeasesSync,
  startManagedSkillServiceOperationSync,
  upsertSkillServiceCatalogSync,
} from "./index.ts";
import type { StoredSkillServiceCatalogRecord } from "./types.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("DELETE FROM managed_skill_service_operation").run();
    db.prepare("DELETE FROM skill_service_binding").run();
    db.prepare("DELETE FROM managed_skill_service").run();
    db.prepare("DELETE FROM skill_service_catalog").run();
    db.prepare("DELETE FROM skill_installation").run();
    db.prepare("DELETE FROM skill_artifact").run();
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(DEFAULT_WORKSPACE_ID, "default", "test", now, now);
  });
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

function seedCatalog(): StoredSkillServiceCatalogRecord {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "renderer",
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
  });
}

function createTestService(runtimeId: string): string {
  const catalog = seedCatalog();
  return createManagedSkillServiceSync({
    workspaceId: "default",
    runtimeId,
    catalogId: catalog.id,
    status: "provisioning",
  }).id;
}

function queueProvision(runtimeId: string, serviceId: string, installationId?: string) {
  return createManagedSkillServiceOperationSync({
    workspaceId: "default",
    runtimeId,
    serviceId,
    installationId,
    operation: "provision",
  });
}

/** Minimal skill_installation row so the operation's FK resolves. */
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

function claimForTest(runtimeId: string, now: Date) {
  return claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId, now });
}

/* ------------------------------------------------------------------ */
/* CRUD + list filtering                                               */
/* ------------------------------------------------------------------ */

test("creates and reads a provision operation with the triggering installation", () => {
  const runtimeId = createTestRuntime();
  const serviceId = createTestService(runtimeId);
  const installationId = createMinimalInstallation(runtimeId);
  const op = queueProvision(runtimeId, serviceId, installationId);

  const reread = readManagedSkillServiceOperationSync(op.id, "default");
  assert.ok(reread);
  assert.equal(reread.operation, "provision");
  assert.equal(reread.status, "pending");
  assert.equal(reread.installationId, installationId);
  assert.equal(reread.serviceId, serviceId);
  assert.equal(reread.runtimeId, runtimeId);
});

test("lists operations filtered by serviceId", () => {
  // Distinct runtimes so createManagedSkillServiceSync (dedup on
  // workspace+runtime+catalog) yields two different services.
  const runtimeA = createTestRuntime();
  const runtimeB = createTestRuntime();
  const serviceA = createTestService(runtimeA);
  const serviceB = createTestService(runtimeB);

  queueProvision(runtimeA, serviceA);
  queueProvision(runtimeA, serviceA);
  queueProvision(runtimeB, serviceB);

  const forA = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: serviceA });
  assert.equal(forA.length, 2);
  assert.ok(forA.every((op) => op.serviceId === serviceA));

  const forB = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: serviceB });
  assert.equal(forB.length, 1);
});

/* ------------------------------------------------------------------ */
/* Lease + fencing (mirrors skill-installation-operation pattern)      */
/* ------------------------------------------------------------------ */

test("claim grants a lease and fences a second claim", () => {
  const runtimeId = createTestRuntime();
  const serviceId = createTestService(runtimeId);
  queueProvision(runtimeId, serviceId);

  const claimed = claimForTest(runtimeId, new Date("2026-01-01T00:00:00Z"));
  assert.ok(claimed);
  assert.equal(claimed.status, "claimed");
  assert.ok(claimed.leaseExpiresAt, "claim must set a lease");
  assert.equal(claimed.leaseExpiresAt, new Date("2026-01-01T00:02:00Z").toISOString());

  const second = claimForTest(runtimeId, new Date("2026-01-01T00:00:10Z"));
  assert.equal(second, null, "claimed operation must not be claimable again");
});

test("start requires claimed + unexpired lease; fails from pending or expired", () => {
  const runtimeId = createTestRuntime();
  const serviceId = createTestService(runtimeId);
  const op = queueProvision(runtimeId, serviceId);

  assert.equal(
    startManagedSkillServiceOperationSync({ operationId: op.id, workspaceId: "default", now: new Date("2026-01-01T00:00:00Z") }),
    false,
    "pending operation is not startable",
  );

  claimForTest(runtimeId, new Date("2026-01-01T00:00:00Z"));
  assert.equal(
    startManagedSkillServiceOperationSync({ operationId: op.id, workspaceId: "default", now: new Date("2026-01-01T00:00:30Z") }),
    true,
  );
  assert.equal(readManagedSkillServiceOperationSync(op.id, "default")?.status, "running");
});

test("heartbeat renews the lease while claimed/running, fails after expiry", () => {
  const runtimeId = createTestRuntime();
  const serviceId = createTestService(runtimeId);
  const op = queueProvision(runtimeId, serviceId);

  claimForTest(runtimeId, new Date("2026-01-01T00:00:00Z"));
  const original = readManagedSkillServiceOperationSync(op.id, "default")!.leaseExpiresAt;

  assert.equal(
    renewManagedSkillServiceOperationLeaseSync({ operationId: op.id, workspaceId: "default", now: new Date("2026-01-01T00:01:00Z") }),
    true,
  );
  const renewed = readManagedSkillServiceOperationSync(op.id, "default")!.leaseExpiresAt;
  assert.ok(renewed! > original!, "renew must extend the lease");

  assert.equal(
    renewManagedSkillServiceOperationLeaseSync({ operationId: op.id, workspaceId: "default", now: new Date("2026-01-01T00:04:00Z") }),
    false,
    "renew after expiry must fail",
  );
});

test("complete and fail require an unexpired lease and clear it", () => {
  const runtimeId = createTestRuntime();
  const serviceId = createTestService(runtimeId);
  const op = queueProvision(runtimeId, serviceId);

  // Complete before claim: no lease → rejected.
  assert.equal(
    completeManagedSkillServiceOperationSync({ operationId: op.id, workspaceId: "default", now: new Date("2026-01-01T00:00:00Z") }),
    false,
  );

  claimForTest(runtimeId, new Date("2026-01-01T00:00:00Z"));
  assert.equal(
    completeManagedSkillServiceOperationSync({ operationId: op.id, workspaceId: "default", now: new Date("2026-01-01T00:00:30Z") }),
    true,
  );
  const succeeded = readManagedSkillServiceOperationSync(op.id, "default")!;
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.leaseExpiresAt, undefined, "complete must clear the lease");

  // A fresh operation that expires mid-run must not complete.
  const op2 = queueProvision(runtimeId, serviceId);
  claimForTest(runtimeId, new Date("2026-01-01T00:10:00Z"));
  assert.equal(
    completeManagedSkillServiceOperationSync({ operationId: op2.id, workspaceId: "default", now: new Date("2026-01-01T00:13:00Z") }),
    false,
  );

  // Fail requires an unexpired lease too.
  const op3 = queueProvision(runtimeId, serviceId);
  claimForTest(runtimeId, new Date("2026-01-01T00:20:00Z"));
  assert.equal(
    failManagedSkillServiceOperationSync({
      operationId: op3.id,
      workspaceId: "default",
      errorCode: "skill_service.provision_failed",
      errorMessage: "image pull failed",
      now: new Date("2026-01-01T00:20:30Z"),
    }),
    true,
  );
  const failed = readManagedSkillServiceOperationSync(op3.id, "default")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "skill_service.provision_failed");
  assert.equal(failed.errorMessage, "image pull failed");
  assert.equal(failed.leaseExpiresAt, undefined);
});

test("reaper re-queues expired claimed/running operations and leaves fresh ones", () => {
  const runtimeId = createTestRuntime();
  const serviceId = createTestService(runtimeId);
  const expired = queueProvision(runtimeId, serviceId);
  claimForTest(runtimeId, new Date("2026-01-01T00:00:00Z"));

  const fresh = queueProvision(runtimeId, serviceId);
  const freshRuntime = createTestRuntime();
  const freshService = createTestService(freshRuntime);
  const freshClaimed = queueProvision(freshRuntime, freshService);
  claimForTest(freshRuntime, new Date("2026-01-01T01:00:00Z"));

  const requeued = requeueExpiredManagedSkillServiceOperationLeasesSync({
    workspaceId: "default",
    now: new Date("2026-01-01T00:10:00Z"),
  });
  assert.equal(requeued, 1, "only the expired operation is re-queued");

  const expiredAfter = readManagedSkillServiceOperationSync(expired.id, "default")!;
  assert.equal(expiredAfter.status, "pending");
  assert.equal(expiredAfter.leaseExpiresAt, undefined);

  // Re-claimable after reaper.
  const reClaimed = claimForTest(runtimeId, new Date("2026-01-01T00:11:00Z"));
  assert.ok(reClaimed);
  assert.equal(reClaimed.id, expired.id);

  // The still-fresh claimed operation keeps its lease.
  assert.equal(readManagedSkillServiceOperationSync(freshClaimed.id, "default")?.status, "claimed");
  assert.equal(listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId: freshService }).length, 1);
});
