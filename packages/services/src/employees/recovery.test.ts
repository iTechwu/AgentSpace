import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  bindEmployeeRuntimeSync,
  getDatabase,
  listRecoveryOperationsSync,
  listStaleCommitJournalsSync,
  readEmployeeBindingGenerationSync,
  readEmployeeRuntimeBindingSync,
  setAssignmentArtifactDigestSync,
  upsertTaskCommitJournalSync,
} from "@dofe-agent/db";
import {
  assertBindingGenerationCurrentSync,
  promoteTaskOutputsToWorkspaceSync,
  runFullRecoverySync,
  setAttachmentStorageClientForTests,
} from "../index.ts";
import { createTestTosAttachmentStorage } from "../testing/tos-attachment-storage.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-recovery-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
const testStorage = createTestTosAttachmentStorage();

let runtimeSeq = 0;
let taskSeq = 0;

function insertRuntime(): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  runtimeSeq += 1;
  const runtimeId = `runtime-rec-${runtimeSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  return runtimeId;
}

function setupEmployeeWorkspace(employeeName: string, seed: string): void {
  // Promote REAL output bytes so the workspace head revision references a
  // readable blob (the recovery mount_workspace phase verifies blob readability).
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-rec-setup-${taskSeq}`;
  const taskId = `task-rec-setup-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-rec', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
  promoteTaskOutputsToWorkspaceSync({
    workspaceId: "default",
    taskId,
    employeeName,
    outputs: [{ path: "a.txt", bytes: new TextEncoder().encode(`seed-${seed}`) }],
  });
}

function insertSkill(seed: string): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  const skillId = `skill-rec-${seed}`;
  db.prepare(
    `INSERT INTO skill (id, workspace_id, name, description, config_json, created_at, updated_at)
     VALUES (?, 'default', ?, '', '{}', ?, ?)`,
  ).run(skillId, skillId, now, now);
  return skillId;
}

function assignSkill(employeeName: string, skillId: string, digest?: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_skill (workspace_id, employee_name, skill_id, created_at)
     VALUES ('default', ?, ?, ?) ON CONFLICT(workspace_id, employee_name, skill_id) DO NOTHING`,
  ).run(employeeName, skillId, now);
  if (digest) {
    setAssignmentArtifactDigestSync({ workspaceId: "default", employeeName, skillId, digest });
  }
}

function insertTaskForJournal(seed: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = insertRuntime();
  const taskId = `task-rec-${seed}-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-rec', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
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
  for (const name of ["Alice", "Bob", "Carol", "Dan", "Erin"]) {
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

test("D-06/07/08: full recovery from an offline runtime completes and advances generation", () => {
  const runtimeId = insertRuntime();
  setupEmployeeWorkspace("Alice", "a");
  // Simulate an existing (offline) binding at generation 1.
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Alice", runtimeId });
  assert.equal(readEmployeeBindingGenerationSync("Alice", "default"), 1);

  const result = runFullRecoverySync({
    workspaceId: "default",
    employeeName: "Alice",
    targetRuntimeId: runtimeId,
  });

  assert.equal(result.phase, "completed", `recovery failed: ${result.errorMessage}`);
  assert.equal(readEmployeeBindingGenerationSync("Alice", "default"), 2, "recovery must advance the generation");
  assert.equal(readEmployeeRuntimeBindingSync("Alice", "default")?.status, "online");

  const ops = listRecoveryOperationsSync({ workspaceId: "default", employeeName: "Alice" });
  assert.ok(ops.length >= 1);
  assert.equal(ops[0]!.phase, "completed");
});

test("recovery without a target runtime fails at allocate and keeps the binding offline", () => {
  setupEmployeeWorkspace("Bob", "b");
  const result = runFullRecoverySync({ workspaceId: "default", employeeName: "Bob" });
  assert.notEqual(result.phase, "completed");
  assert.equal(result.phase, "failed");
});

test("D-11: an unpinnable/missing bound skill artifact blocks recovery (needs_attention)", () => {
  const runtimeId = insertRuntime();
  setupEmployeeWorkspace("Carol", "c");
  const skillId = insertSkill("c");
  assignSkill("Carol", skillId, "b".repeat(64)); // pinned digest with NO artifact row

  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Carol", runtimeId });

  const result = runFullRecoverySync({
    workspaceId: "default",
    employeeName: "Carol",
    targetRuntimeId: runtimeId,
  });
  assert.notEqual(result.phase, "completed");
  assert.match(result.errorMessage ?? "", /missing/i);
  assert.equal(readEmployeeRuntimeBindingSync("Carol", "default")?.status, "needs_attention");
});

test("D-09: a stale binding generation cannot write after a rebind", () => {
  const runtimeId = insertRuntime();
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Dan", runtimeId });
  assert.equal(readEmployeeBindingGenerationSync("Dan", "default"), 1);

  // The old node holds generation 1 while the current generation is 2.
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Dan", runtimeId });
  assert.equal(readEmployeeBindingGenerationSync("Dan", "default"), 2);

  assert.throws(() => {
    assertBindingGenerationCurrentSync({ workspaceId: "default", employeeName: "Dan", expectedGeneration: 1 });
  }, /STALE_BINDING_GENERATION/);
});

test("recovery completes even without a bound skill (no pinned digests)", () => {
  const runtimeId = insertRuntime();
  setupEmployeeWorkspace("Erin", "e");
  bindEmployeeRuntimeSync({ workspaceId: "default", employeeName: "Erin", runtimeId });

  const result = runFullRecoverySync({
    workspaceId: "default",
    employeeName: "Erin",
    targetRuntimeId: runtimeId,
  });
  assert.equal(result.phase, "completed");
});

test("reconciliation: a preparing_commit task is flagged for the backlog", () => {
  insertTaskForJournal("backlog");
  const db = getDatabase();
  const row = db.prepare(`SELECT id FROM agent_task_queue WHERE workspace_id = 'default' ORDER BY created_at DESC LIMIT 1`).get();
  const latestTaskId = String(row?.id ?? "");
  upsertTaskCommitJournalSync({ taskId: latestTaskId, workspaceId: "default", commitState: "preparing" });
  const staleCutoff = new Date(Date.now() - 600 * 1000).toISOString();
  db.prepare(`UPDATE task_commit_journal SET updated_at = ? WHERE task_id = ?`).run(staleCutoff, latestTaskId);
  const backlog = listStaleCommitJournalsSync({ workspaceId: "default", staleBeforeSeconds: 300 });
  assert.ok(backlog.some((journal) => journal.taskId === latestTaskId));
});
