import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import {
  createManagedSkillServiceSync,
  createSkillServiceBindingSync,
  listSkillServiceBindingsSync,
  readSkillServiceCatalogSync,
  setManagedSkillServiceHealthSync,
  upsertSkillServiceCatalogSync,
} from "./index.ts";

before(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
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

function createMinimalArtifactAndInstallation(runtimeId: string): string {
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

test("service catalog persists and reads back the hardened admission fields", () => {
  const entry = upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "hardened-renderer",
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"a".repeat(64)}`,
    templateDigest: `sha256:${"b".repeat(64)}`,
    sbomDigest: `sha256:${"c".repeat(64)}`,
    runAsNonRoot: true,
    readOnlyRootfs: true,
    capDropJson: JSON.stringify(["NET_ADMIN", "SYS_TIME"]),
  });

  const reread = readSkillServiceCatalogSync("hardened-renderer", "1.0.0", "default");
  assert.ok(reread);
  assert.equal(reread!.sbomDigest, `sha256:${"c".repeat(64)}`);
  assert.equal(reread!.runAsNonRoot, true);
  assert.equal(reread!.readOnlyRootfs, true);
  assert.deepEqual(JSON.parse(reread!.capDropJson), ["NET_ADMIN", "SYS_TIME"]);

  // Defaults when the fields are omitted.
  const minimal = upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "minimal-renderer",
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: `sha256:${"d".repeat(64)}`,
  });
  const minimalReread = readSkillServiceCatalogSync("minimal-renderer", "1.0.0", "default");
  assert.ok(minimalReread);
  assert.equal(minimalReread!.sbomDigest, undefined);
  assert.equal(minimalReread!.runAsNonRoot, false);
  assert.equal(minimalReread!.readOnlyRootfs, true);
  assert.deepEqual(JSON.parse(minimalReread!.capDropJson), ["ALL"]);
});

test("service catalog entry is immutable per (slug, templateVersion) and readable", () => {
  const entry = upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: "sha256:abc",
    protocol: "http",
    configSchemaVersion: 3,
  });
  assert.equal(entry.slug, "document-renderer");
  assert.equal(entry.imageDigest, "sha256:abc");
  assert.equal(entry.rollbackClass, "stateless");

  const reread = upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: "sha256:different",
  });
  assert.equal(reread.id, entry.id);
  assert.equal(reread.imageDigest, "sha256:abc"); // first write wins (immutable template)

  const byKey = readSkillServiceCatalogSync("document-renderer", "2.1.0", "default");
  assert.ok(byKey);
  assert.equal(byKey!.configSchemaVersion, 3);
});

test("managed service instance + binding + health updates", () => {
  const runtimeId = createTestRuntime();
  const catalog = upsertSkillServiceCatalogSync({
    workspaceId: "default",
    slug: "document-renderer",
    templateVersion: "2.1.0",
    deploymentType: "managed_service",
    imageDigest: "sha256:abc",
  });

  const service = createManagedSkillServiceSync({
    workspaceId: "default",
    runtimeId,
    catalogId: catalog.id,
    status: "provisioning",
  });
  assert.equal(service.status, "provisioning");

  const healthy = setManagedSkillServiceHealthSync({
    serviceId: service.id,
    workspaceId: "default",
    status: "ready",
    health: "healthy",
  });
  assert.equal(healthy, true);

  const installationId = createMinimalArtifactAndInstallation(runtimeId);
  const binding = createSkillServiceBindingSync({
    installationId,
    serviceId: service.id,
    catalogTemplateVersion: "2.1.0",
    serviceImageDigest: "sha256:abc",
    endpointRef: "runtime-private://renderer",
    configSchemaVersion: 3,
  });
  assert.equal(binding.serviceId, service.id);
  assert.equal(binding.endpointRef, "runtime-private://renderer");

  const bindings = listSkillServiceBindingsSync(installationId);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.serviceImageDigest, "sha256:abc");
});
