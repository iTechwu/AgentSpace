import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach, after } from "node:test";
import {
  bindEmployeeRuntimeSync,
  cancelQueuedTaskSync,
  claimNextQueuedTaskForRuntimeSync,
  completeCommittedTaskSync,
  completeQueuedTaskSync,
  createWorkspaceSync,
  enqueueNativeTaskSync,
  failQueuedTaskSync,
  getDatabase,
  listTaskExecutionEventsSync,
  markTaskCommittedSync,
  markTaskPreparingCommitSync,
  readMcpTaskSessionGrantSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
  startQueuedTaskSync,
  updateAgentRuntimeManagedFieldsSync,
  writeMcpTaskSessionGrantSync,
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
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
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

test("idempotent queue creation returns the original task without duplicate lifecycle events", () => {
  createRuntimeAndBinding();
  const input = {
    idempotencyKey: "agent-output-mention:source-task:atlas",
    assignee: "Atlas",
    title: "Follow up",
    channel: "general",
    priority: "medium" as const,
    triggerType: "mention_chat",
  };

  const first = enqueueNativeTaskSync(input);
  const second = enqueueNativeTaskSync(input);

  assert.ok(first);
  assert.equal(second?.id, first.id);
  const queueCount = getDatabase().prepare("SELECT COUNT(*) AS count FROM agent_task_queue WHERE id = ?")
    .get(first.id) as { count?: number } | undefined;
  assert.equal(Number(queueCount?.count), 1);
  assert.equal(listTaskExecutionEventsSync({ taskId: first.id }).filter((event) => event.type === "queued").length, 1);
});

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

  markTaskPreparingCommitSync(queued.id);
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

test("late start callbacks do not reopen completed or failed tasks", () => {
  const runtimeId = createRuntimeAndBinding();
  const completedTask = enqueueNativeTaskSync({ assignee: "Atlas", title: "Completed", channel: "general", priority: "high" });
  const failedTask = enqueueNativeTaskSync({ assignee: "Atlas", title: "Failed", channel: "general", priority: "high" });
  assert.ok(completedTask);
  assert.ok(failedTask);

  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(completedTask.id);
  completeQueuedTaskSync({ taskId: completedTask.id });
  failQueuedTaskSync({ taskId: failedTask.id, errorText: "Provider failed." });

  assert.equal(startQueuedTaskSync(completedTask.id).status, "completed");
  assert.equal(startQueuedTaskSync(failedTask.id).status, "failed");
});

test("late completion and failure callbacks do not overwrite cancellation", () => {
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({ assignee: "Atlas", title: "Cancelled", channel: "general", priority: "high" });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);
  cancelQueuedTaskSync({ taskId: queued.id });

  assert.equal(completeQueuedTaskSync({ taskId: queued.id }).status, "cancelled");
  assert.equal(failQueuedTaskSync({ taskId: queued.id, errorText: "Late failure." }).status, "cancelled");
});

test("cancel interrupts a preparing_commit task so a late commit cannot land (Spec #4)", () => {
  // 审批驳回/重试中止与员工任务提交的竞态：员工提交已进入 preparing_commit（EAD §7
  // running → preparing_commit），此时审批被驳回触发 cancel。cancel 必须覆盖
  // preparing_commit，否则守卫静默 no-op，任务继续 committed → 被驳回的运行仍按成功结算。
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({ assignee: "Atlas", title: "Commit race", channel: "general", priority: "high" });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);
  markTaskPreparingCommitSync(queued.id);
  assert.equal(readQueuedTaskSync(queued.id)?.status, "preparing_commit");

  const cancelled = cancelQueuedTaskSync({ taskId: queued.id, errorText: "workflow_approval_rejected" });
  assert.equal(cancelled.status, "cancelled", "cancel 必须覆盖 preparing_commit");
  assert.equal(readQueuedTaskSync(queued.id)?.status, "cancelled");

  // 迟到的 commit 第二阶段（preparing_commit → committed）守卫拒绝，提交无法落地。
  assert.throws(
    () => markTaskCommittedSync({ taskId: queued.id }),
    /workflow_task_commit_conflict/,
    "preparing_commit 被 cancel 后，迟到 commit 须被守卫拒绝",
  );
  assert.equal(readQueuedTaskSync(queued.id)?.status, "cancelled");
});

test("cancel does not touch a committed task (committed is the no-return durability point)", () => {
  // committed 是 EAD §7 的持久不可逆点（与 failQueuedTaskSync 的 NOT IN (…,'committed')
  // 一致）：数据已原子落盘，cancel 无法撤销，故守卫不覆盖 committed。
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({ assignee: "Atlas", title: "Already committed", channel: "general", priority: "high" });
  assert.ok(queued);
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);
  markTaskPreparingCommitSync(queued.id);
  markTaskCommittedSync({ taskId: queued.id });
  assert.equal(readQueuedTaskSync(queued.id)?.status, "committed");

  const afterCancel = cancelQueuedTaskSync({ taskId: queued.id, errorText: "workflow_approval_rejected" });
  assert.equal(afterCancel.status, "committed", "committed 不可被 cancel 撤销");
  assert.equal(readQueuedTaskSync(queued.id)?.status, "committed");
});

test("queued task identity survives employee rename through employeeId", () => {
  const runtimeId = createRuntimeAndBinding();
  const queued = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Rename-safe task",
    channel: "general",
    priority: "high",
  });
  assert.ok(queued);
  assert.equal(queued.employeeId, "emp-atlas");
  assert.equal(queued.employeeName, "Atlas");
  assert.equal(queued.agentId, "Atlas", "legacy display-name field remains compatible");

  getDatabase().prepare(
    `UPDATE workspace_employee SET name = 'Atlas Renamed', updated_at = ?
      WHERE workspace_id = 'default' AND id = 'emp-atlas'`,
  ).run(new Date().toISOString());

  const claimed = claimNextQueuedTaskForRuntimeSync(runtimeId);
  assert.equal(claimed?.id, queued.id);
  assert.equal(claimed?.employeeId, "emp-atlas");
  assert.equal(claimed?.bindingGeneration, 1);
  assert.equal(
    getDatabase().prepare(`SELECT agent_id AS "agentId" FROM agent_router_session WHERE id = ?`).get(queued.routerSessionId)?.agentId,
    "emp-atlas",
  );
  assert.ok(
    listTaskExecutionEventsSync({ workspaceId: "default", taskId: queued.id })
      .every((event) => event.agentId === "emp-atlas"),
  );
});

test("task claims allow local legacy runtimes but block incomplete managed provisioning", () => {
  const runtimeId = createRuntimeAndBinding();
  updateAgentRuntimeManagedFieldsSync({
    runtimeId,
    managedCredentialId: "legacy-local-credential",
  });
  const legacyTask = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Legacy local task",
    channel: "general",
    priority: "high",
  });
  assert.ok(legacyTask);
  const claimedLegacyTask = claimNextQueuedTaskForRuntimeSync(runtimeId);
  assert.equal(claimedLegacyTask?.id, legacyTask.id);
  assert.equal(
    claimedLegacyTask?.runtimeCredentialId,
    "legacy-local-credential",
    "billing attribution snapshots the credential at claim time",
  );

  updateAgentRuntimeManagedFieldsSync({
    runtimeId,
    provisioningState: "credential_recovering",
  });
  const recoveringTask = enqueueNativeTaskSync({
    assignee: "Atlas",
    title: "Provisioning task must wait",
    channel: "general",
    priority: "high",
  });
  assert.ok(recoveringTask);
  assert.equal(claimNextQueuedTaskForRuntimeSync(runtimeId), null);
});

test("cancelQueuedTaskSync removes the MCP session grant from the task workspace", () => {
  const { workspaceId, queued } = createTaskWithMcpGrant("cancel");

  cancelQueuedTaskSync({ taskId: queued.id });

  assert.equal(readMcpTaskSessionGrantSync(queued.id, workspaceId), null);
});

test("failQueuedTaskSync removes the MCP session grant from the task workspace", () => {
  const { workspaceId, queued } = createTaskWithMcpGrant("fail");

  failQueuedTaskSync({ taskId: queued.id, errorText: "Provider failed." });

  assert.equal(readMcpTaskSessionGrantSync(queued.id, workspaceId), null);
});

test("markTaskCommittedSync removes the MCP session grant from the task workspace", () => {
  const { workspaceId, runtimeId, queued } = createTaskWithMcpGrant("commit");
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);

  markTaskPreparingCommitSync(queued.id);
  markTaskCommittedSync({ taskId: queued.id });

  assert.equal(readMcpTaskSessionGrantSync(queued.id, workspaceId), null);
});

test("legacy completion removes the MCP session grant from the task workspace", () => {
  const { workspaceId, runtimeId, queued } = createTaskWithMcpGrant("complete");
  claimNextQueuedTaskForRuntimeSync(runtimeId);
  startQueuedTaskSync(queued.id);

  completeQueuedTaskSync({ taskId: queued.id });

  assert.equal(readMcpTaskSessionGrantSync(queued.id, workspaceId), null);
});

function createTaskWithMcpGrant(prefix: string): {
  workspaceId: string;
  runtimeId: string;
  queued: NonNullable<ReturnType<typeof enqueueNativeTaskSync>>;
} {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const workspace = createWorkspaceSync({
    id: `task-grant-${prefix}-${suffix}`,
    slug: `task-grant-${prefix}-${suffix}`,
    name: "Task grant test",
    createdBy: "test",
  });
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO workspace_employee (
       id, workspace_id, name, role, origin, summary, fit, status, instructions, created_at, updated_at
     ) VALUES (?, ?, 'Atlas', 'Agent', 'manual', 'Test employee', 'Ready', 'active', '', ?, ?)`,
  ).run(`emp-${prefix}-${suffix}`, workspace.id, now, now);
  const runtimeId = registerDaemonRuntimesSync({
    workspaceId: workspace.id,
    daemonKey: `daemon-${prefix}-${suffix}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Remote Codex", version: "test" }],
  }).runtimes[0]!.id;
  bindEmployeeRuntimeSync({ workspaceId: workspace.id, employeeName: "Atlas", runtimeId });
  const queued = enqueueNativeTaskSync({
    workspaceId: workspace.id,
    assignee: "Atlas",
    title: `${prefix} delegated task`,
    channel: "general",
    priority: "high",
  });
  assert.ok(queued);
  writeMcpTaskSessionGrantSync({
    workspaceId: workspace.id,
    runtimeId,
    taskId: queued.id,
    attemptId: "attempt-1",
    encryptedBundleJson: "encrypted-test-bundle",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { workspaceId: workspace.id, runtimeId, queued };
}
