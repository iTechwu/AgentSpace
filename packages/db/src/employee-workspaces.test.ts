import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  commitWorkspaceRevisionSync,
  bindEmployeeRuntimeSync,
  createRecoveryOperationSync,
  createWorkspaceRevisionSync,
  ensureEmployeePersistentWorkspaceSync,
  listEmployeeArtifactsSync,
  listWorkspaceRevisionsSync,
  publishEmployeeArtifactSync,
  readEmployeePersistentWorkspaceSync,
  readEmployeeBindingGenerationSync,
  readHeadRevisionSync,
  restoreWorkspaceRevisionSync,
  setStoredEmployeeSkillAssignmentsSync,
  softDeleteEmployeeArtifactSync,
  upsertAgentSkillRequirementConfigSync,
  getDatabase,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-ews-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

const MANIFEST_JSON = (seed: string): string => JSON.stringify({ taskId: `task-${seed}`, files: [{ path: "a.txt", sha256: seed, size: 1, mediaType: "text/plain" }] });

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  seedDefaultWorkspaceIfMissing();
});

let taskSeq = 0;

/** Inserts a real agent_task_queue row (employee_artifact.source_task_id is a hard FK). */
function insertTestTask(): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  taskSeq += 1;
  const runtimeId = `runtime-ew-${taskSeq}`;
  const taskId = `task-ew-${taskSeq}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, 'default', 'agent-ew', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, runtimeId, now, now, now);
  return taskId;
}

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
  db.exec("DELETE FROM agent_task_queue WHERE agent_id = 'agent-ew'");
  db.exec("DELETE FROM agent_runtime WHERE id LIKE 'runtime-ew-%'");
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

test("ensure creates a persistent workspace once and is idempotent", () => {
  const first = ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const second = ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  assert.equal(first.id, second.id);
  assert.equal(first.employeeName, "Alice");
  assert.equal(first.storageHealth, "unknown");
});

test("revision commits atomically and advances the head", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const revision = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "a".repeat(64),
    manifestJson: MANIFEST_JSON("1"),
    status: "pending",
  });
  assert.equal(revision.status, "pending");

  const committed = commitWorkspaceRevisionSync(revision.id, "default");
  assert.equal(committed.status, "committed");

  const head = readHeadRevisionSync("Alice", "default");
  assert.equal(head?.id, committed.id);
  const ws = readEmployeePersistentWorkspaceSync("Alice", "default");
  assert.equal(ws?.headRevisionId, committed.id);
  assert.equal(ws?.storageHealth, "healthy");
});

test("D-05: identical digest re-creates the same revision (no duplicate publish)", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const first = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "b".repeat(64),
    manifestJson: MANIFEST_JSON("2"),
  });
  const second = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "b".repeat(64),
    manifestJson: MANIFEST_JSON("2"),
  });
  assert.equal(second.id, first.id);
  assert.equal(listWorkspaceRevisionsSync({ employeeName: "Alice", workspaceId: "default" }).length, 1);
});

test("commit conflict: stale parent against head throws REVISION_CONFLICT", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const first = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "c".repeat(64),
    manifestJson: MANIFEST_JSON("3"),
  });
  commitWorkspaceRevisionSync(first.id, "default"); // head = first

  const second = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    parentRevisionId: first.id,
    manifestDigest: "d".repeat(64),
    manifestJson: MANIFEST_JSON("4"),
  });
  commitWorkspaceRevisionSync(second.id, "default"); // head = second

  // A concurrent writer based on the stale head (first) must be rejected.
  const stale = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    parentRevisionId: first.id,
    manifestDigest: "e".repeat(64),
    manifestJson: MANIFEST_JSON("5"),
  });
  assert.throws(() => {
    commitWorkspaceRevisionSync(stale.id, "default");
  }, /REVISION_CONFLICT/);
});

test("restore produces a NEW head revision, never overwriting history", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Bob" });
  const v1 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    manifestDigest: "f".repeat(64),
    manifestJson: MANIFEST_JSON("6"),
  });
  commitWorkspaceRevisionSync(v1.id, "default");
  const v2 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    parentRevisionId: v1.id,
    manifestDigest: "g".repeat(64),
    manifestJson: MANIFEST_JSON("7"),
  });
  commitWorkspaceRevisionSync(v2.id, "default");

  const restored = restoreWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    targetRevisionId: v1.id,
  });
  assert.equal(restored.status, "committed");
  assert.notEqual(restored.id, v1.id, "restore must not mutate the original revision");
  // The restored head carries the target's manifest, not the caller's.
  assert.equal(restored.manifestJson, v1.manifestJson);
  assert.equal(restored.sourceKind, "history_restore");
  assert.equal(restored.restoredFromRevisionId, v1.id);
  assert.equal(readHeadRevisionSync("Bob", "default")?.id, restored.id);
});

test("restore rejects a revision owned by another employee", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Alice" });
  const alice = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Alice",
    manifestDigest: "1".repeat(64),
    manifestJson: MANIFEST_JSON("alice"),
  });
  commitWorkspaceRevisionSync(alice.id, "default");

  assert.throws(
    () => restoreWorkspaceRevisionSync({
      workspaceId: "default",
      employeeName: "Bob",
      targetRevisionId: alice.id,
    }),
    /does not belong to employee/i,
  );
});

test("restore can re-apply the same target after an intervening head", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Bob" });
  const v1 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    manifestDigest: "2".repeat(64),
    manifestJson: MANIFEST_JSON("restore-v1"),
  });
  commitWorkspaceRevisionSync(v1.id, "default");
  const firstRestore = restoreWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    targetRevisionId: v1.id,
  });
  const intervening = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    parentRevisionId: firstRestore.id,
    manifestDigest: "3".repeat(64),
    manifestJson: MANIFEST_JSON("intervening"),
  });
  commitWorkspaceRevisionSync(intervening.id, "default");

  const secondRestore = restoreWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    targetRevisionId: v1.id,
  });
  assert.notEqual(secondRestore.id, firstRestore.id);
  assert.equal(secondRestore.parentRevisionId, intervening.id);
  assert.equal(secondRestore.manifestJson, v1.manifestJson);
  assert.equal(secondRestore.manifestDigest, v1.manifestDigest, "restore keeps the truthful manifest content digest");
  assert.equal(readHeadRevisionSync("Bob", "default")?.id, secondRestore.id);
});

test("restore advances the binding generation to fence already-claimed tasks", () => {
  const db = getDatabase();
  const now = new Date().toISOString();
  const runtimeId = `runtime-restore-fence-${Date.now()}`;
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'codex', 'Restore Fence', 'online', ?, ?)`,
  ).run(runtimeId, now, now);
  bindEmployeeRuntimeSync({
    workspaceId: "default",
    employeeName: "Bob",
    runtimeId,
  });
  const generationBefore = readEmployeeBindingGenerationSync("Bob", "default");
  const v1 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    manifestDigest: "4".repeat(64),
    manifestJson: MANIFEST_JSON("fenced-restore"),
  });
  commitWorkspaceRevisionSync(v1.id, "default");

  restoreWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    targetRevisionId: v1.id,
  });
  assert.equal(readEmployeeBindingGenerationSync("Bob", "default"), (generationBefore ?? 0) + 1);
});

test("restore is blocked while an employee recovery operation is active", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Bob" });
  const target = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Bob",
    manifestDigest: "5".repeat(64),
    manifestJson: MANIFEST_JSON("blocked-during-recovery"),
  });
  commitWorkspaceRevisionSync(target.id, "default");
  createRecoveryOperationSync({
    workspaceId: "default",
    employeeName: "Bob",
    toGeneration: 1,
  });

  assert.throws(
    () => restoreWorkspaceRevisionSync({
      workspaceId: "default",
      employeeName: "Bob",
      targetRevisionId: target.id,
    }),
    /EMPLOYEE_RECOVERY_ACTIVE/,
  );
});

test("published artifacts are listed and soft-deleted", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Carol" });
  const artifact = publishEmployeeArtifactSync({
    workspaceId: "default",
    employeeName: "Carol",
    contentDigest: "h".repeat(64),
    mediaType: "application/pdf",
    fileName: "report.pdf",
    sizeBytes: 1024,
  });
  assert.ok(artifact.id.startsWith("eart-"));

  assert.equal(listEmployeeArtifactsSync({ employeeName: "Carol", workspaceId: "default" }).length, 1);
  assert.equal(softDeleteEmployeeArtifactSync(artifact.id, "default"), true);
  assert.equal(listEmployeeArtifactsSync({ employeeName: "Carol", workspaceId: "default" }).length, 0);
});

test("publishing the same (task, digest, file) is idempotent and never duplicates", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Dan" });
  const taskId = insertTestTask();
  const input = {
    workspaceId: "default",
    employeeName: "Dan",
    contentDigest: "i".repeat(64),
    mediaType: "text/plain",
    fileName: "out.txt",
    sizeBytes: 8,
    sourceTaskId: taskId,
  };
  const first = publishEmployeeArtifactSync(input);
  const second = publishEmployeeArtifactSync(input);
  assert.equal(second.id, first.id, "retry must return the existing artifact");
  assert.equal(
    listEmployeeArtifactsSync({ employeeName: "Dan", workspaceId: "default" }).length,
    1,
    "no duplicate artifact rows",
  );
});

test("head commit CAS: a stale parent can no longer advance head", () => {
  ensureEmployeePersistentWorkspaceSync({ workspaceId: "default", employeeName: "Erin" });
  const v1 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Erin",
    manifestDigest: "j".repeat(64),
    manifestJson: MANIFEST_JSON("10"),
  });
  commitWorkspaceRevisionSync(v1.id, "default");

  // v2 is created with parent v1, but v3 is committed first — v2 is now stale.
  const v2 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Erin",
    parentRevisionId: v1.id,
    manifestDigest: "k".repeat(64),
    manifestJson: MANIFEST_JSON("11"),
  });
  const v3 = createWorkspaceRevisionSync({
    workspaceId: "default",
    employeeName: "Erin",
    parentRevisionId: v1.id,
    manifestDigest: "l".repeat(64),
    manifestJson: MANIFEST_JSON("12"),
  });
  commitWorkspaceRevisionSync(v3.id, "default");

  assert.throws(() => commitWorkspaceRevisionSync(v2.id, "default"), /REVISION_CONFLICT/);
  assert.equal(readHeadRevisionSync("Erin", "default")?.id, v3.id, "stale commit must not advance head");
});

test("non-EAD assignments store the stable employee_id and cascade on employee delete", () => {
  const db = getDatabase();
  const now = new Date().toISOString();
  // Real skill row (agent_skill.skill_id is a hard FK).
  db.prepare(
    `INSERT INTO skill (id, workspace_id, name, description, config_json, created_at, updated_at)
     VALUES ('skill-mig-1', 'default', 'Mig Test', 'mig', '{}', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);

  setStoredEmployeeSkillAssignmentsSync("Alice", ["skill-mig-1"], "default");
  const assignment = db.prepare(
    `SELECT employee_id AS employeeId FROM agent_skill WHERE workspace_id = 'default' AND employee_name = 'Alice'`,
  ).get() as { employeeId?: string } | undefined;
  assert.equal(assignment?.employeeId, "emp-alice", "agent_skill must store employee_id");

  upsertAgentSkillRequirementConfigSync({
    workspaceId: "default",
    employeeName: "Alice",
    skillId: "skill-mig-1",
    configJson: "{}",
    encryptedSecretsJson: "{}",
  });
  const config = db.prepare(
    `SELECT employee_id AS employeeId FROM agent_skill_requirement_config WHERE workspace_id = 'default' AND employee_name = 'Alice'`,
  ).get() as { employeeId?: string } | undefined;
  assert.equal(config?.employeeId, "emp-alice", "requirement config must store employee_id");

  // Deleting the workspace_employee cascades the non-EAD rows (FK CASCADE).
  db.prepare(`DELETE FROM workspace_employee WHERE id = 'emp-alice'`).run();
  const remainingAssignments = db.prepare(
    `SELECT 1 AS x FROM agent_skill WHERE workspace_id = 'default' AND employee_name = 'Alice'`,
  ).all();
  const remainingConfigs = db.prepare(
    `SELECT 1 AS x FROM agent_skill_requirement_config WHERE workspace_id = 'default' AND employee_name = 'Alice'`,
  ).all();
  assert.equal(remainingAssignments.length, 0, "agent_skill cascaded on employee delete");
  assert.equal(remainingConfigs.length, 0, "requirement config cascaded on employee delete");
});
