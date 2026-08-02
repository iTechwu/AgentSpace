import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { setAttachmentStorageClientForTests } from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import {
  approveRecoveryOperationSync,
  bindEmployeeRuntimeSync,
  claimRecoveryOperationsForWorkerSync,
  getDatabase,
  listRecoveryOperationsSync,
  readEmployeeBindingGenerationSync,
  readRecoveryOperationSync,
  releaseRecoveryOperationLeaseSync,
} from "@dofe-agent/db";
import {
  advanceRecoverableOperationsSync,
  createEmployeeRecoveryOperationSync,
  promoteTaskOutputsToWorkspaceSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-recovery-worker-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();
let taskSeq = 0;

function insertTestTask(): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-rw-${taskSeq}`;
  const taskId = `task-rw-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'online', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-rw', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
  return taskId;
}

function setupEmployeeWorkspace(employeeName: string, seed: string): void {
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId: insertTestTask(),
    employeeName,
    outputs: [{ path: "a.txt", bytes: new TextEncoder().encode(`seed-${seed}`) }],
  });
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
  db.exec("DELETE FROM employee_recovery_operation");
  db.exec("DELETE FROM runtime_workspace_mount_operation");
  db.exec("DELETE FROM task_commit_journal");
  db.exec("DELETE FROM employee_artifact");
  db.exec("DELETE FROM employee_workspace_revision");
  db.exec("DELETE FROM employee_persistent_workspace");
  db.exec("DELETE FROM agent_skill_requirement_config");
  db.exec("DELETE FROM agent_skill");
  db.exec("DELETE FROM skill_artifact_file");
  db.exec("DELETE FROM skill_artifact");
  db.exec("DELETE FROM content_blob");
  db.exec("DELETE FROM skill");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM employee_runtime_binding");
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

test("the worker walks a recovery to completed across multiple ticks and advances the generation", () => {
  const runtimeId = insertTestTask().replace("task-rw", "runtime-rw");
  // insertTestTask also created a runtime `runtime-rw-N`; reuse it as the target.
  const db = getDatabase();
  const row = db.prepare(`SELECT id FROM agent_runtime WHERE id = ?`).get(runtimeId) as { id?: string } | undefined;
  const targetRuntimeId = row?.id ?? runtimeId;

  setupEmployeeWorkspace("Alice", "a");
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Alice", runtimeId: targetRuntimeId });
  assert.equal(readEmployeeBindingGenerationSync("Alice", "default"), 1);

  createEmployeeRecoveryOperationSync({
    workspaceId: "default",
    employeeName: "Alice",
    actorUserId: "user-1",
  });

  // Each tick advances exactly one phase; 6 phases to reach `completed`.
  const ticks: string[] = [];
  for (let tick = 0; tick < 12; tick += 1) {
    const result = advanceRecoverableOperationsSync({ workspaceId: "default", limit: 10 });
    const ops = listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice", limit: 1 });
    const phase = ops[0]?.phase ?? "none";
    ticks.push(phase);
    if (phase === "completed" || phase === "failed") {
      break;
    }
    assert.ok(result.advanced + result.waiting + result.failed > 0 || phase === "none", "worker made progress");
  }

  const final = listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice", limit: 1 })[0];
  assert.ok(final, "operation exists");
  assert.equal(final.phase, "completed", `expected completed, ticks were: ${ticks.join(" -> ")} error: ${final?.errorMessage ?? "none"}`);
  assert.equal(readEmployeeBindingGenerationSync("Alice", "default"), 2, "recovery advanced the binding generation");
});

test("the worker skips operations pending approval", () => {
  const runtimeId = insertTestTask().replace("task-rw", "runtime-rw");
  setupEmployeeWorkspace("Alice", "b");
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Alice", runtimeId });

  createEmployeeRecoveryOperationSync({
    workspaceId: "default",
    employeeName: "Alice",
    actorUserId: "user-1",
    requireApproval: true,
  });

  const result = advanceRecoverableOperationsSync({ workspaceId: "default", limit: 10 });
  assert.equal(result.advanced, 0, "pending-approval op must not advance");
  const op = listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice", limit: 1 })[0];
  assert.equal(op?.phase, "allocate", "still in allocate");
});

test("a recovery worker lease prevents overlapping workers from claiming the same operation", () => {
  const runtimeId = insertTestTask().replace("task-rw", "runtime-rw");
  setupEmployeeWorkspace("Alice", "lease");
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Alice", runtimeId });
  const operation = createEmployeeRecoveryOperationSync({
    workspaceId: "default",
    employeeName: "Alice",
    targetRuntimeId: runtimeId,
  });

  const first = claimRecoveryOperationsForWorkerSync({ workspaceId: "default", limit: 1 });
  const overlapping = claimRecoveryOperationsForWorkerSync({ workspaceId: "default", limit: 1 });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.id, operation.id);
  assert.equal(overlapping.length, 0);

  assert.equal(releaseRecoveryOperationLeaseSync({
    operationId: operation.id,
    workspaceId: "default",
    leaseToken: first[0]!.leaseToken,
  }), true);
  assert.equal(claimRecoveryOperationsForWorkerSync({ workspaceId: "default", limit: 1 }).length, 1);
});

test("approving a pending operation unblocks the worker", () => {
  const runtimeId = insertTestTask().replace("task-rw", "runtime-rw");
  setupEmployeeWorkspace("Alice", "c");
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Alice", runtimeId });

  const created = createEmployeeRecoveryOperationSync({
    workspaceId: "default",
    employeeName: "Alice",
    actorUserId: "user-1",
    requireApproval: true,
  });
  assert.equal(created.approvalState, "pending");

  // Still blocked until approved.
  advanceRecoverableOperationsSync({ workspaceId: "default", limit: 10 });
  assert.equal(listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice", limit: 1 })[0]?.phase, "allocate");

  approveRecoveryOperationSync({
    operationId: created.id,
    workspaceId: "default",
    approvedByUserId: "admin-1",
  });
  assert.equal(readRecoveryOperationSync(created.id, "default")?.approvalState, "approved");

  // After approval the worker walks it to completed.
  for (let tick = 0; tick < 12; tick += 1) {
    advanceRecoverableOperationsSync({ workspaceId: "default", limit: 10 });
    const op = listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice", limit: 1 })[0];
    if (op?.phase === "completed" || op?.phase === "failed") {
      break;
    }
  }
  assert.equal(listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice", limit: 1 })[0]?.phase, "completed");
});
