import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  createEmployeeDataLegalHoldSync,
  ensureEmployeePersistentWorkspaceSync,
  getDatabase,
  publishEmployeeArtifactSync,
  readContentBlobSync,
  releaseEmployeeDataLegalHoldSync,
  softDeleteEmployeeArtifactSync,
  upsertContentBlobSync,
} from "@dofe-agent/db";
import {
  promoteTaskOutputsToWorkspaceSync,
  runEmployeeLifecycleMaintenanceSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import { sha256Hex } from "../attachments/storage.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-lifecycle-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();
let taskSeq = 0;

function insertTestTask(): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-lc-${taskSeq}`;
  const taskId = `task-lc-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-lc', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
  return taskId;
}

function persistTestBlob(bytes: Uint8Array): string {
  const digest = sha256Hex(bytes);
  testStorage.client.putContentAddressedBlobSync({ workspaceId: "default", sha256: digest, contentBytes: bytes });
  upsertContentBlobSync({
    workspaceId: "default",
    sha256: digest,
    storageProvider: "tos",
    storageKey: `workspaces/default/content-blobs/${digest.slice(0, 2)}/${digest}`,
    sizeBytes: bytes.byteLength,
  });
  return digest;
}

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testStorage.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  seedDefaultWorkspaceIfMissing();
});

function seedDefaultWorkspaceIfMissing(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('default', 'default', 'Dofe Agent', '', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
}

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM audit_log WHERE code IN ('employee.data_legal_hold_created', 'employee.data_legal_hold_released')");
  db.exec("DELETE FROM employee_data_legal_hold");
  db.exec("DELETE FROM employee_artifact");
  db.exec("DELETE FROM employee_workspace_revision");
  db.exec("DELETE FROM employee_persistent_workspace");
  db.exec("DELETE FROM content_blob");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_runtime");
  seedTestEmployees();
});

function seedTestEmployees(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const name of ["Alice"]) {
    db.prepare(
      `INSERT INTO workspace_employee (id, workspace_id, name, role, origin, summary, fit, status, instructions, created_at, updated_at)
       VALUES (?, 'default', ?, 'Agent', 'manual', ?, 'Ready', 'active', '', ?, ?)
       ON CONFLICT (workspace_id, name) DO NOTHING`,
    ).run(`emp-${name.toLowerCase()}`, name, `${name} test employee`, now, now);
  }
}

after(() => {
  process.chdir(originalCwd);
});

test("lifecycle hard-deletes expired soft-deleted artifacts and reclaims their blobs", () => {
  const db = getDatabase();
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const bytes = new TextEncoder().encode("expired deliverable");
  const digest = sha256Hex(bytes);
  const artifact = publishEmployeeArtifactSync({
    workspaceId: "default",
    employeeName: "Alice",
    contentDigest: digest,
    mediaType: "text/plain",
    fileName: "old.txt",
    sizeBytes: bytes.byteLength,
    sourceTaskId: insertTestTask(),
  });
  softDeleteEmployeeArtifactSync(artifact.id, "default");
  // Expire the soft-delete window.
  db.prepare(
    `UPDATE employee_artifact SET deleted_at = ? WHERE id = ?`,
  ).run(new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString(), artifact.id);

  const result = runEmployeeLifecycleMaintenanceSync({
    workspaceId: "default",
    softDeleteRetentionSeconds: 30 * 24 * 3600,
    orphanBlobRetainSeconds: 0,
    now: new Date().toISOString(),
  });

  assert.equal(result.totalArtifactsHardDeleted, 1);
  assert.equal(db.prepare(`SELECT 1 AS x FROM employee_artifact WHERE id = ?`).get(artifact.id), undefined);
  // The freed blob was reclaimed from storage.
  assert.equal(readContentBlobSync(digest, "default"), null);
});

test("lifecycle keeps recent soft-deleted artifacts (recovery window) and referenced blobs", () => {
  const db = getDatabase();
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  // A recent soft-delete is inside the recovery window → must be kept.
  const recentBytes = new TextEncoder().encode("recent deliverable");
  persistTestBlob(recentBytes);
  const recent = publishEmployeeArtifactSync({
    workspaceId: "default",
    employeeName: "Alice",
    contentDigest: sha256Hex(recentBytes),
    mediaType: "text/plain",
    fileName: "recent.txt",
    sizeBytes: recentBytes.byteLength,
    sourceTaskId: insertTestTask(),
  });
  softDeleteEmployeeArtifactSync(recent.id, "default");

  // A referenced blob (part of a live revision) must never be reclaimed.
  const referencedBytes = new TextEncoder().encode("referenced");
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Alice",
    outputs: [{ path: "keep.txt", bytes: referencedBytes }],
  });

  // An unreferenced orphan blob older than the retain window → reclaimed.
  const orphanBytes = new TextEncoder().encode("orphan");
  const orphanSha = sha256Hex(orphanBytes);
  testStorage.client.putContentAddressedBlobSync({
    workspaceId: "default",
    sha256: orphanSha,
    contentBytes: orphanBytes,
  });
  upsertContentBlobSync({
    workspaceId: "default",
    sha256: orphanSha,
    storageProvider: "tos",
    storageKey: `workspaces/default/content-blobs/${orphanSha.slice(0, 2)}/${orphanSha}`,
    sizeBytes: orphanBytes.byteLength,
  });

  const result = runEmployeeLifecycleMaintenanceSync({
    workspaceId: "default",
    softDeleteRetentionSeconds: 30 * 24 * 3600,
    orphanBlobRetainSeconds: 0,
    now: new Date().toISOString(),
  });

  assert.equal(result.totalArtifactsHardDeleted, 0, "recent soft-delete must be kept");
  assert.ok(
    db.prepare(`SELECT 1 AS x FROM employee_artifact WHERE id = ?`).get(recent.id),
    "recent artifact row kept",
  );
  assert.ok(readContentBlobSync(sha256Hex(recentBytes), "default"), "soft-deleted artifact blob kept during recovery window");
  assert.ok(readContentBlobSync(sha256Hex(referencedBytes), "default"), "referenced blob kept");
  assert.equal(readContentBlobSync(orphanSha, "default"), null, "unreferenced orphan blob reclaimed");
  assert.equal(result.totalOrphanBlobsReclaimed, 1);
});

test("active legal holds block artifact and orphan blob GC until audited release", () => {
  const db = getDatabase();
  const employeeWorkspace = ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const bytes = new TextEncoder().encode("held deliverable");
  const digest = persistTestBlob(bytes);
  const artifact = publishEmployeeArtifactSync({
    workspaceId: "default",
    employeeName: "Alice",
    contentDigest: digest,
    mediaType: "text/plain",
    fileName: "held.txt",
    sizeBytes: bytes.byteLength,
    sourceTaskId: insertTestTask(),
  });
  softDeleteEmployeeArtifactSync(artifact.id, "default");
  db.prepare(`UPDATE employee_artifact SET deleted_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString(),
    artifact.id,
  );
  const hold = createEmployeeDataLegalHoldSync({
    workspaceId: "default",
    employeeId: employeeWorkspace.employeeId,
    resourceType: "artifact",
    resourceId: artifact.id,
    reason: "litigation preservation",
    createdByUserId: "legal-admin",
    createdByDisplayName: "Legal Admin",
  });

  const held = runEmployeeLifecycleMaintenanceSync({
    workspaceId: "default",
    softDeleteRetentionSeconds: 30 * 24 * 3600,
    orphanBlobRetainSeconds: 0,
  });
  assert.equal(held.totalArtifactsHardDeleted, 0);
  assert.equal(held.workspaces[0]?.artifactsHeld, 1);
  assert.ok(readContentBlobSync(digest, "default"));

  releaseEmployeeDataLegalHoldSync({
    id: hold.id,
    workspaceId: "default",
    releasedByUserId: "legal-admin",
    releaseReason: "matter closed",
  });
  const released = runEmployeeLifecycleMaintenanceSync({
    workspaceId: "default",
    softDeleteRetentionSeconds: 30 * 24 * 3600,
    orphanBlobRetainSeconds: 0,
  });
  assert.equal(released.totalArtifactsHardDeleted, 1);
  assert.equal(readContentBlobSync(digest, "default"), null);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_log WHERE code IN ('employee.data_legal_hold_created', 'employee.data_legal_hold_released')`)
      .get()?.count,
    2,
  );
});

test("content blob legal hold protects an otherwise orphaned object", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const bytes = new TextEncoder().encode("held orphan");
  const digest = persistTestBlob(bytes);
  createEmployeeDataLegalHoldSync({
    workspaceId: "default",
    resourceType: "content_blob",
    resourceId: digest,
    reason: "preserve source evidence",
  });

  const result = runEmployeeLifecycleMaintenanceSync({
    workspaceId: "default",
    orphanBlobRetainSeconds: 0,
  });
  assert.equal(result.totalOrphanBlobsReclaimed, 0);
  assert.ok(readContentBlobSync(digest, "default"));
});
