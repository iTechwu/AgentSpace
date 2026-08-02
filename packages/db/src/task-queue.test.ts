import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach, after } from "node:test";
import {
  bindEmployeeRuntimeSync,
  claimNextQueuedTaskForRuntimeSync,
  completeCommittedTaskSync,
  completeQueuedTaskSync,
  enqueueNativeTaskSync,
  getDatabase,
  markTaskCommittedSync,
  registerDaemonRuntimesSync,
  startQueuedTaskSync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-task-queue-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  seedDefaultWorkspaceIfMissing();
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM task_commit_journal");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_task_attempt");
  db.exec("DELETE FROM agent_router_event");
  db.exec("DELETE FROM agent_router_provider_session");
  db.exec("DELETE FROM agent_router_context_snapshot");
  db.exec("DELETE FROM employee_runtime_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  seedTestEmployees();
});

function seedTestEmployees(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const name of ["Atlas"]) {
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

function seedDefaultWorkspaceIfMissing(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('default', 'default', 'Dofe Agent', '', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
}

function createRuntimeAndBinding(employeeName = "Atlas"): string {
  const snapshot = registerDaemonRuntimesSync({
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  });
  const runtimeId = snapshot.runtimes[0]!.id;
  bindEmployeeRuntimeSync({ employeeName, runtimeId });
  return runtimeId;
}

test("completeCommittedTaskSync requires committed status (EAD §7)", () => {
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Draft plan",
    channel: "general",
    priority: "high",
  });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);

  assert.throws(
    () => completeCommittedTaskSync({ taskId: queued.id }),
    /cannot be completed while status is "running"/,
  );

  markTaskCommittedSync({ taskId: queued.id });
  const completed = completeCommittedTaskSync({ taskId: queued.id });
  assert.equal(completed.status, "completed");
});

test("completeQueuedTaskSync still allows legacy completion from running for compatibility", () => {
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Legacy task",
    channel: "general",
    priority: "high",
  });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);

  const completed = completeQueuedTaskSync({ taskId: queued.id });
  assert.equal(completed.status, "completed");
});
