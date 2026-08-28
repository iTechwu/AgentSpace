import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { setAttachmentStorageClientForTests } from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";
import {
  bindEmployeeRuntimeSync,
  claimNextQueuedTaskForRuntimeSync,
  completeCommittedTaskSync,
  enqueueNativeTaskSync,
  getDatabase,
  readTaskCommitJournalSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
  markTaskCommittedSync,
  markTaskPreparingCommitSync,
  startQueuedTaskSync,
  upsertTaskCommitJournalSync,
} from "@dofe-agent/db";
import { reconcileStaleCommitJournalsSync } from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-reconcile-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();

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
  db.exec("DELETE FROM task_commit_journal");
  db.exec("DELETE FROM employee_artifact");
  db.exec("DELETE FROM employee_workspace_revision");
  db.exec("DELETE FROM employee_persistent_workspace");
  db.exec("DELETE FROM content_blob");
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

/** Claims and starts a task, then crosses the prepare boundary; the journal drives the rest. */
function createRunningTask(): { taskId: string; runtimeId: string } {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-reconcile-${Date.now()}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  bindEmployeeRuntimeSync({ employeeName: "Alice", runtimeId });
  const queued = enqueueNativeTaskSync({
    assignee: "Alice",
    title: "Reconcile me",
    channel: "general",
    priority: "high",
  });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);
  markTaskPreparingCommitSync(queued.id);
  return { taskId: queued.id, runtimeId };
}

test("reconciliation commits a task whose outputs are still derivable", () => {
  const { taskId } = createRunningTask();
  // The task received outputs, promotion failed, journal left preparing.
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "workspace_promotion_failed",
    errorMessage: "transient",
  });
  // Backdate so it is stale.
  getDatabase().prepare(
    `UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?`,
  ).run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: () => ({
      outputs: [{ path: "repository/src/a.ts", bytes: new TextEncoder().encode("reconciled") }],
      deletedPaths: [],
    }),
  });

  assert.equal(result.committed, 1);
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "committed");
  assert.equal(readQueuedTaskSync(taskId)?.status, "committed");
});

test("reconciliation retries when outputs are unrecoverable and attempts remain", () => {
  const { taskId } = createRunningTask();
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "workspace_promotion_failed",
  });
  getDatabase().prepare(
    `UPDATE task_commit_journal SET updated_at = ?, attempt = 1 WHERE task_id = ?`,
  ).run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: () => null,
  });

  assert.equal(result.retried, 1);
  const journal = readTaskCommitJournalSync(taskId, "default");
  assert.equal(journal?.commitState, "preparing");
  assert.equal(journal?.attempt, 2, "attempt must be bumped");
});

test("checkpoint state writes preserve all configured reconciliation attempts", () => {
  const { taskId } = createRunningTask();
  for (const errorCode of [
    "workflow_completion_effects_pending",
    "workflow_completion_effects_checkpointed",
    "workspace_promotion_failed",
  ]) {
    upsertTaskCommitJournalSync({
      taskId,
      workspaceId: "default",
      employeeName: "Alice",
      commitState: "preparing",
      errorCode,
    });
  }
  expectJournalAttempt(taskId, 0);

  for (const expectedAttempt of [1, 2]) {
    ageJournal(taskId);
    const result = reconcileStaleCommitJournalsSync({
      workspaceId: "default",
      staleBeforeSeconds: 3600,
      maxAttempts: 3,
      deriveOutputs: () => null,
    });
    assert.equal(result.retried, 1);
    expectJournalAttempt(taskId, expectedAttempt);
  }
  ageJournal(taskId);
  const exhausted = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: () => null,
  });
  assert.equal(exhausted.rolledBack, 1);
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "rolled_back");
});

function ageJournal(taskId: string): void {
  getDatabase().prepare("UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?")
    .run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);
}

function expectJournalAttempt(taskId: string, expected: number): void {
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.attempt, expected);
}

test("reconciliation rolls back when attempts are exhausted and outputs are unrecoverable", () => {
  const { taskId } = createRunningTask();
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "workspace_promotion_failed",
  });
  getDatabase().prepare(
    `UPDATE task_commit_journal SET updated_at = ?, attempt = 3 WHERE task_id = ?`,
  ).run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: () => null,
  });

  assert.equal(result.rolledBack, 1);
  const journal = readTaskCommitJournalSync(taskId, "default");
  assert.equal(journal?.commitState, "rolled_back");
  assert.equal(journal?.errorCode, "commit_reconciliation_rolled_back");
  assert.equal(readQueuedTaskSync(taskId)?.status, "failed");
});

test("reconciliation rolls back a stale-lease promotion that cannot commit", () => {
  const { taskId } = createRunningTask();
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "workspace_promotion_failed",
  });
  getDatabase().prepare(
    `UPDATE task_commit_journal SET updated_at = ?, attempt = 3 WHERE task_id = ?`,
  ).run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  // The employee was rebound, so the claim-time generation is stale: promotion
  // must fail, and the journal must roll back rather than commit into the new
  // workspace.
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES ('another-runtime', 'default', 'codex', 'Another', 'online', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
  ).run();
  bindEmployeeRuntimeSync({ employeeName: "Alice", runtimeId: "another-runtime" });

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: () => ({
      outputs: [{ path: "a.txt", bytes: new TextEncoder().encode("late") }],
      deletedPaths: [],
    }),
  });

  assert.equal(result.rolledBack, 1);
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "rolled_back");
});

test("duplicate reconciliation runs are idempotent (no double-commit across replicas)", () => {
  const { taskId } = createRunningTask();
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "workspace_promotion_failed",
    errorMessage: "transient",
  });
  getDatabase().prepare(
    `UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?`,
  ).run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  const derive = () => ({
    outputs: [{ path: "idempotent.txt", bytes: new TextEncoder().encode("once") }],
    deletedPaths: [],
  });

  // Replica A commits the stale journal.
  const first = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: derive,
  });
  assert.equal(first.committed, 1);
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "committed");

  // Replica B processes the same journal afterwards → no-op, no second revision.
  const second = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: derive,
  });
  assert.equal(second.committed, 0, "a committed journal is never re-committed");

  const revisionCount = getDatabase().prepare(
    `SELECT COUNT(*) AS c FROM employee_workspace_revision WHERE workspace_id = 'default'`,
  ).get();
  assert.equal(Number(revisionCount?.c), 1, "exactly one revision is created despite two runs");
});

test("a complete effects snapshot recovers a journal left at effects-pending by a process crash", () => {
  const { taskId } = createRunningTask();
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "workflow_completion_effects_pending",
  });
  getDatabase().prepare("UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?")
    .run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    isReplaySafe: () => true,
    deriveOutputs: () => ({
      outputs: [{ path: "checkpointed.txt", bytes: new TextEncoder().encode("safe") }],
      deletedPaths: [],
    }),
  });

  assert.equal(result.committed, 1);
  assert.equal(readQueuedTaskSync(taskId)?.status, "committed");
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "committed");
});

test("completed tasks retry only the idempotent finalizer without re-promoting outputs", () => {
  const { taskId } = createRunningTask();
  markTaskPreparingCommitSync(taskId);
  markTaskCommittedSync({ taskId, employeeName: "Alice" });
  completeCommittedTaskSync({ taskId, resultJson: { output: "done" } });
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "commit_reconciliation_retrying",
    errorMessage: "projection failed",
  });
  getDatabase().prepare("UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?")
    .run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);
  let finalized = 0;

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    deriveOutputs: () => {
      throw new Error("completed task must not be promoted again");
    },
    finalizeTask: (task) => {
      assert.equal(task.status, "completed");
      finalized += 1;
    },
  });

  assert.equal(result.committed, 1);
  assert.equal(finalized, 1);
  assert.equal(readQueuedTaskSync(taskId)?.status, "completed");
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "committed");
});

test("a committed task left by a crash resumes finalization without re-promoting outputs", () => {
  const { taskId } = createRunningTask();
  markTaskPreparingCommitSync(taskId);
  markTaskCommittedSync({
    taskId,
    employeeName: "Alice",
    workspaceRevisionId: "ewr-before-crash",
    artifactIds: ["eart-before-crash"],
  });
  getDatabase().prepare("UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?")
    .run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);
  let finalized = 0;

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    deriveOutputs: () => {
      throw new Error("a committed task must not be promoted again");
    },
    finalizeTask: (task) => {
      assert.equal(task.status, "committed");
      finalized += 1;
    },
  });

  assert.equal(result.committed, 1);
  assert.equal(finalized, 1);
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.workspaceRevisionId, "ewr-before-crash");
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.artifactIdsJson, '["eart-before-crash"]');
});

test("a failed completed-task finalizer remains retryable and is never rolled back", () => {
  const { taskId } = createRunningTask();
  markTaskPreparingCommitSync(taskId);
  markTaskCommittedSync({ taskId, employeeName: "Alice" });
  completeCommittedTaskSync({ taskId });
  upsertTaskCommitJournalSync({
    taskId,
    workspaceId: "default",
    employeeName: "Alice",
    commitState: "preparing",
    errorCode: "commit_reconciliation_retrying",
  });
  getDatabase().prepare("UPDATE task_commit_journal SET updated_at = ?, attempt = 99 WHERE task_id = ?")
    .run(new Date(Date.now() - 7200 * 1000).toISOString(), taskId);

  const result = reconcileStaleCommitJournalsSync({
    workspaceId: "default",
    staleBeforeSeconds: 3600,
    maxAttempts: 1,
    finalizeTask: () => {
      throw new Error("projection dependency unavailable");
    },
  });

  assert.equal(result.retried, 1);
  assert.equal(result.rolledBack, 0);
  assert.equal(readQueuedTaskSync(taskId)?.status, "completed");
  assert.equal(readTaskCommitJournalSync(taskId, "default")?.commitState, "preparing");
});
