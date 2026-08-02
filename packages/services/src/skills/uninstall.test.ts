import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  claimNextManagedSkillServiceOperationForRuntimeSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceBindingsSync,
  readManagedSkillServiceSync,
  readSkillInstallationSync,
  upsertSkillServiceCatalogSync,
} from "@dofe-agent/db";
import {
  buildAndPersistSkillArtifactSync,
  completeManagedSkillServiceProvisionOperationSync,
  createSkillInstallationPlanSync,
  resetWorkspaceStateSync,
  retireUnreferencedManagedSkillServicesSync,
  setAttachmentStorageClientForTests,
  uninstallSkillFromRuntimeSync,
  uninstallSkillInstallationSync,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const encoder = new TextEncoder();
const testTosStorage = createTestTosAttachmentStorage();

const CATALOG_SLUG = "uninstall-renderer";

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

function seedCatalog(): string {
  return upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: CATALOG_SLUG,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    networkJson: JSON.stringify({ egressAllowlist: [] }),
  }).id;
}

function buildArtifactWithService(salt: string) {
  return buildAndPersistSkillArtifactSync({
    name: "Uninstall Skill",
    files: [{ path: "SKILL.md", bytes: encoder.encode(`# Body ${salt}\n`) }],
    services: [{ catalogSlug: CATALOG_SLUG, templateVersion: "1.0.0", required: true }],
  });
}

/** Plan → provision-complete → service ready + binding + installation ready. */
async function provisionToReady(runtimeId: string, artifactDigest: string) {
  const installation = createSkillInstallationPlanSync({ runtimeId, artifactDigest });
  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    endpointRef: "runtime-private://uninstall-renderer",
  });
  assert.equal(completed.ok, true);
  return { installation, serviceId: claimed.serviceId };
}

test("uninstall cascades service bindings and the retire sweep reclaims the service", async () => {
  const runtimeId = createTestRuntime();
  seedCatalog();
  const artifact = buildArtifactWithService("uninstall-a");
  const { installation, serviceId } = await provisionToReady(runtimeId, artifact.digest);

  assert.equal(readManagedSkillServiceSync(serviceId, "default")?.status, "ready");
  assert.equal(readSkillInstallationSync(installation.id, "default")?.status, "ready");
  assert.equal(listSkillServiceBindingsSync(installation.id).length, 1);

  // Uninstall → the FK cascades the service binding away.
  const uninstalled = uninstallSkillInstallationSync({ workspaceId: "default", installationId: installation.id });
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.removedBindings, 1);
  assert.equal(readSkillInstallationSync(installation.id, "default"), null);
  assert.equal(listSkillServiceBindingsSync(installation.id).length, 0);

  // The service is now unreferenced → the NEXT sweep pass queues a retire
  // (alongside the already-completed provision operation).
  const retired = retireUnreferencedManagedSkillServicesSync({ workspaceId: "default" });
  assert.ok(retired.includes(serviceId));
  const retireOps = listManagedSkillServiceOperationsSync({ workspaceId: "default", serviceId })
    .filter((op) => op.operation === "retire");
  assert.equal(retireOps.length, 1);
  assert.equal(retireOps[0]!.status, "pending");
});

test("uninstallSkillFromRuntimeSync removes every revision for the runtime + digest", async () => {
  const runtimeId = createTestRuntime();
  seedCatalog();
  const artifact = buildArtifactWithService("uninstall-b");
  const v1 = await provisionToReady(runtimeId, artifact.digest);

  // A second revision of the same (runtime, digest).
  const now = new Date().toISOString();
  const v2Id = `inst-${randomLikeId()}`;
  getDatabase().prepare(
    `INSERT INTO skill_installation (id, workspace_id, runtime_id, artifact_digest, status, resolved_lock_json, health, revision, created_at, updated_at)
     VALUES (?, 'default', ?, ?, 'preparing', '{}', 'unknown', 'v2', ?, ?)`,
  ).run(v2Id, runtimeId, artifact.digest, now, now);

  const result = uninstallSkillFromRuntimeSync({ workspaceId: "default", runtimeId, artifactDigest: artifact.digest });
  assert.equal(result.ok, true);
  assert.equal(result.removedInstallations, 2);
  assert.equal(readSkillInstallationSync(v1.installation.id, "default"), null);
  assert.equal(readSkillInstallationSync(v2Id, "default"), null);
});

test("uninstall refuses an unknown installation and reports no-installation", async () => {
  const missing = uninstallSkillInstallationSync({ workspaceId: "default", installationId: `inst-${randomLikeId()}` });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.code, "installation_not_found");

  const runtimeId = createTestRuntime();
  const noInstalls = uninstallSkillFromRuntimeSync({
    workspaceId: "default",
    runtimeId,
    artifactDigest: `sha256:${"b".repeat(64)}`,
  });
  assert.equal(noInstalls.ok, false);
  assert.equal(noInstalls.ok === false && noInstalls.code, "no_installation");
});
