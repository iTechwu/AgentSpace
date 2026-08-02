import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  upsertTaskCommitJournalSync,
  createRecoveryOperationSync,
  failRecoveryOperationSync,
} from "@dofe-agent/db";
import {
  evaluateDataProtectionHealthSync,
  promoteTaskOutputsToWorkspaceSync,
  runBackupRestoreDrillSync,
  runBackupRestoreDrillRunSync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-dph-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();
let taskSeq = 0;

function insertTestTask(): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-dph-${taskSeq}`;
  const taskId = `task-dph-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-dph', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
  return taskId;
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

/** The shared test PG occasionally loses the default workspace row; re-seed it. */
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
  db.exec("DELETE FROM employee_recovery_operation");
  db.exec("DELETE FROM employee_artifact");
  db.exec("DELETE FROM employee_workspace_revision");
  db.exec("DELETE FROM employee_persistent_workspace");
  db.exec("DELETE FROM task_commit_journal");
  db.exec("DELETE FROM content_blob");
  db.exec("DELETE FROM agent_skill");
  db.exec("DELETE FROM skill_artifact_file");
  db.exec("DELETE FROM skill_artifact");
  db.exec("DELETE FROM skill");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_runtime");
  seedTestEmployees();
});

function seedTestEmployees(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const name of ["Alice", "Bob", "Carol", "Dan", "Dave"]) {
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

test("health check flags a stale head revision (workspace_head_age)", () => {
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Alice",
    outputs: [{ path: "a.txt", bytes: new TextEncoder().encode("hi") }],
  });
  // Backdate the head revision well past the policy window.
  const db = getDatabase();
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  db.prepare(
    `UPDATE employee_workspace_revision SET created_at = ? WHERE employee_name = 'Alice'`,
  ).run(old);

  const health = evaluateDataProtectionHealthSync({
    workspaceId: "default",
    headAgePolicySeconds: 7 * 24 * 3600,
  });
  assert.ok(
    health.alerts.some((alert) => alert.code === "workspace_head_age" && alert.employeeName === "Alice"),
    JSON.stringify(health.alerts),
  );
});

test("health check flags a failed recovery (runtime_binding_generation_conflicts)", () => {
  const op = createRecoveryOperationSync({
    workspaceId: "default",
    employeeName: "Bob",
    toGeneration: 1,
  });
  failRecoveryOperationSync({
    operationId: op.id,
    workspaceId: "default",
    errorMessage: "allocate failed: no runtime",
  });

  const health = evaluateDataProtectionHealthSync({ workspaceId: "default" });
  assert.ok(
    health.alerts.some((alert) => alert.code === "runtime_recovery_failed"),
    JSON.stringify(health.alerts),
  );
});

test("health check flags a stale preparing_commit backlog", () => {
  const db = getDatabase();
  const taskId = insertTestTask();
  upsertTaskCommitJournalSync({ taskId, workspaceId: "default", commitState: "preparing" });
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(`UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?`).run(stale, taskId);

  const health = evaluateDataProtectionHealthSync({ workspaceId: "default" });
  assert.ok(
    health.alerts.some((alert) => alert.code === "task_commit_reconciliation_backlog"),
    JSON.stringify(health.alerts),
  );
});

test("D-10: backup/restore drill recomputes the workspace manifest digest identically", () => {
  const outputs = [
    { path: "report.pdf", bytes: new TextEncoder().encode("%PDF-1.4 report") },
    { path: "data.csv", bytes: new TextEncoder().encode("a,b\n1,2\n") },
  ];
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Carol",
    outputs,
  });

  const drill = runBackupRestoreDrillSync({ workspaceId: "default", employeeNames: ["Carol"] });
  assert.equal(drill.ok, true, JSON.stringify(drill.samples));
  assert.equal(drill.samples[0]!.workspaceManifestMatch, true);
  assert.equal(drill.samples[0]!.skillDigestsMatch, true);
});

test("drill reports a mismatch when the stored manifest digest disagrees with the manifest", () => {
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Dave",
    outputs: [{ path: "a.txt", bytes: new TextEncoder().encode("v1") }],
  });
  // Corrupt the stored manifest_digest to simulate a tampered/desynced backup.
  const db = getDatabase();
  db.prepare(
    `UPDATE employee_workspace_revision SET manifest_digest = repeat('0', 64) WHERE employee_name = 'Dave'`,
  ).run();

  const drill = runBackupRestoreDrillSync({ workspaceId: "default", employeeNames: ["Dave"] });
  assert.equal(drill.ok, false);
  assert.equal(drill.samples[0]!.workspaceManifestMatch, false);
});

test("D-10: persistent drill run records the result and status", () => {
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Alice",
    outputs: [{ path: "a.txt", bytes: new TextEncoder().encode("v1") }],
  });

  const run = runBackupRestoreDrillRunSync({
    workspaceId: "default",
    employeeNames: ["Alice"],
    trigger: "manual",
  });

  assert.equal(run.status, "completed");
  assert.equal(run.workspaceId, "default");
  assert.equal(run.drillType, "metadata");
  assert.equal(run.trigger, "manual");
  assert.ok(run.sampleCount >= 1);
  assert.equal(run.successCount, run.sampleCount);
  assert.equal(run.failureCount, 0);
  assert.ok(run.resultJson.length > 2);
});

test("D-10: external_restore drill records the PITR point, snapshot, environment and RTO", () => {
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName: "Bob",
    outputs: [{ path: "b.txt", bytes: new TextEncoder().encode("restored") }],
  });

  const run = runBackupRestoreDrillRunSync({
    workspaceId: "default",
    employeeNames: ["Bob"],
    trigger: "manual",
    restorePointAt: "2026-08-02T00:00:00.000Z",
    sourceSnapshot: "pitr-20260802",
    restoreEnvironment: "scratch-dr-20260802",
    restoreDurationMs: 245_000,
  });

  assert.equal(run.status, "completed");
  assert.equal(run.drillType, "external_restore");
  assert.equal(run.restorePointAt, "2026-08-02T00:00:00.000Z");
  assert.equal(run.sourceSnapshot, "pitr-20260802");
  assert.equal(run.restoreEnvironment, "scratch-dr-20260802");
  assert.equal(run.restoreDurationMs, 245_000);
  assert.ok(run.sampleCount >= 1);
});
