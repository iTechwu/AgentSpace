import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach, after } from "node:test";
import {
  archiveConversationSync,
  bindEmployeeRuntimeSync,
  claimNextQueuedTaskForRuntimeSync,
  createConversationSync,
  createWorkspaceSync,
  enqueueNativeTaskSync,
  countActiveTasksForRuntimeSync,
  findActiveProviderSessionForLaneSync,
  getDatabase,
  isRuntimeAtCapacitySync,
  listConversationParticipantsSync,
  listConversationsForChannelSync,
  listConversationsForEmployeeSync,
  readConversationSync,
  readExecutionLaneForConversationEmployeeSync,
  registerDaemonRuntimesSync,
  resolveTaskRouterConversationIdentity,
  unarchiveConversationSync,
  updateConversationSync,
  upsertLaneProviderSessionSync,
  upsertRuntimeTaskCapacitySync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-conversations-"));

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
  db.exec("DELETE FROM conversation_provider_session");
  db.exec("DELETE FROM conversation_execution_lane");
  db.exec("DELETE FROM conversation_participant");
  db.exec("DELETE FROM conversation");
  db.exec("DELETE FROM task_message");
  db.exec("DELETE FROM task_execution_event");
  db.exec("DELETE FROM agent_task_attempt");
  db.exec("DELETE FROM agent_router_provider_session");
  db.exec("DELETE FROM agent_router_event");
  db.exec("DELETE FROM agent_router_context_snapshot");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_router_session");
  db.exec("DELETE FROM employee_runtime_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
  seedTestEmployees();
});

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

function seedTestEmployees(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const name of ["Atlas", "Vega"]) {
    db.prepare(
      `INSERT INTO workspace_employee (id, workspace_id, name, role, origin, summary, fit, status, instructions, created_at, updated_at)
       VALUES (?, 'default', ?, 'Agent', 'manual', ?, 'Ready', 'active', '', ?, ?)
       ON CONFLICT (workspace_id, name) DO UPDATE SET id = EXCLUDED.id, summary = EXCLUDED.summary, updated_at = EXCLUDED.updated_at`,
    ).run(`emp-${name.toLowerCase()}`, name, `${name} test employee`, now, now);
  }
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

function createEmployeeId(employeeName: string): string {
  return `emp-${employeeName.toLowerCase()}`;
}

test("createConversationSync 建立 Conversation + Lane + 独立 Router Session", () => {
  const result = createConversationSync({
    employeeId: createEmployeeId("Atlas"),
    employeeName: "Atlas",
    createdByUserId: "user-1",
  });
  assert.equal(result.conversation.status, "draft");
  assert.equal(result.conversation.kind, "direct");
  assert.equal(result.lane.conversationId, result.conversation.id);
  assert.equal(result.lane.employeeId, createEmployeeId("Atlas"));
  assert.ok(result.lane.routerSessionId, "Lane 必须绑定独立 Router Session");

  const sessionRow = getDatabase().prepare(
    "SELECT conversation_key AS key FROM agent_router_session WHERE id = ?",
  ).get(result.lane.routerSessionId) as { key?: string } | undefined;
  assert.equal(sessionRow?.key, `conversation:${result.conversation.id}`);
});

test("createConversationSync 相同 idempotencyKey 返回同一 Conversation", () => {
  const first = createConversationSync({
    employeeId: createEmployeeId("Atlas"),
    employeeName: "Atlas",
    createdByUserId: "user-1",
    idempotencyKey: "new-conversation-op-1",
  });
  const second = createConversationSync({
    employeeId: createEmployeeId("Atlas"),
    employeeName: "Atlas",
    createdByUserId: "user-1",
    idempotencyKey: "new-conversation-op-1",
  });
  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(second.lane.id, first.lane.id);
});

test("createConversationSync 群聊会话不建 Lane，但写入员工参与者并按 channel 可列", () => {
  const result = createConversationSync({
    kind: "group",
    channelId: "general",
    createdByUserId: "user-1",
    employeeParticipants: [
      { employeeId: "emp-atlas", employeeName: "Atlas" },
      { employeeId: "emp-vega", employeeName: "Vega" },
    ],
  });
  assert.equal(result.conversation.kind, "group");
  assert.equal(result.lane, undefined, "群聊创建时不建立 Lane");

  const participants = listConversationParticipantsSync(result.conversation.id);
  const employeeParticipants = participants.filter((participant) => participant.participantType === "employee");
  assert.equal(employeeParticipants.length, 2, "群聊会话应写入两个员工参与者");

  const byChannel = listConversationsForChannelSync({ channelId: "general" });
  assert.ok(byChannel.some((conversation) => conversation.id === result.conversation.id));
});

test("listConversationsForEmployeeSync 按 humanUserId 过滤，隔离跨用户会话", () => {
  const atlas = createEmployeeId("Atlas");
  createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-2" });

  const allForAtlas = listConversationsForEmployeeSync({ employeeId: atlas });
  assert.equal(allForAtlas.length, 2, "无 humanUserId 时返回全部");

  const user1Only = listConversationsForEmployeeSync({ employeeId: atlas, humanUserId: "user-1" });
  assert.equal(user1Only.length, 1);
  assert.equal(user1Only[0]!.createdByUserId, "user-1");
});

test("listConversationsForEmployeeSync 只返回该员工的会话", () => {
  const atlas = createEmployeeId("Atlas");
  const vega = createEmployeeId("Vega");
  createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  createConversationSync({ employeeId: vega, employeeName: "Vega", createdByUserId: "user-1" });

  const atlasList = listConversationsForEmployeeSync({ employeeId: atlas });
  assert.equal(atlasList.length, 2);
  assert.ok(atlasList.every((conversation) => conversation.workspaceId === "default"));

  const vegaList = listConversationsForEmployeeSync({ employeeId: vega });
  assert.equal(vegaList.length, 1);
});

test("updateConversationSync 归档/恢复不删除会话", () => {
  const result = createConversationSync({
    employeeId: createEmployeeId("Atlas"),
    employeeName: "Atlas",
    createdByUserId: "user-1",
  });
  const archived = archiveConversationSync(result.conversation.id);
  assert.equal(archived.status, "archived");
  assert.ok(archived.archivedAt, "归档应记录时间");

  const restored = unarchiveConversationSync(result.conversation.id);
  assert.equal(restored.status, "idle");
  assert.equal(restored.archivedAt, undefined);

  const retitled = updateConversationSync({
    conversationId: result.conversation.id,
    title: "优化视频脚本",
    summary: "优化视频脚本并生成最终 MP4",
    summarySource: "user",
  });
  assert.equal(retitled.title, "优化视频脚本");
  assert.equal(retitled.summarySource, "user");
});

test("Execution Lane 以 conversation+employee 唯一，Provider Session 按 Lane 隔离", () => {
  const atlas = createEmployeeId("Atlas");
  const a1 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  const a2 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });

  const lane1 = readExecutionLaneForConversationEmployeeSync("default", a1.conversation.id, atlas);
  const lane2 = readExecutionLaneForConversationEmployeeSync("default", a2.conversation.id, atlas);
  assert.ok(lane1 && lane2, "两个会话都应有 Lane");
  assert.notEqual(lane1!.id, lane2!.id, "不同会话 Lane 必须不同");
  assert.notEqual(lane1!.routerSessionId, lane2!.routerSessionId, "不同会话 Router Session 必须不同");

  upsertLaneProviderSessionSync({ executionLaneId: lane1!.id, provider: "codex", providerSessionId: "p1" });
  upsertLaneProviderSessionSync({ executionLaneId: lane2!.id, provider: "codex", providerSessionId: "p2" });
  assert.equal(findActiveProviderSessionForLaneSync({ executionLaneId: lane1!.id })?.providerSessionId, "p1");
  assert.equal(findActiveProviderSessionForLaneSync({ executionLaneId: lane2!.id })?.providerSessionId, "p2");
});

test("resolveTaskRouterConversationIdentity 优先使用 conversation:<id>", () => {
  const identity = resolveTaskRouterConversationIdentity({
    id: "queue-1",
    agentId: "Atlas",
    triggerType: "channel_chat",
    inputJson: JSON.stringify({ conversationId: "conversation-abc", channelName: "ops", title: "Ops" }),
    issueId: undefined,
  });
  assert.deepEqual(identity, {
    conversationKey: "conversation:conversation-abc",
    sourceType: "conversation",
    title: "Ops",
  });
});

test("同员工不同会话（不同 Lane）可并行 claim，同 Lane 串行", () => {
  createRuntimeAndBinding("Atlas");
  const atlas = createEmployeeId("Atlas");
  const a1 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  const a2 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  const lane1 = readExecutionLaneForConversationEmployeeSync("default", a1.conversation.id, atlas)!;
  const lane2 = readExecutionLaneForConversationEmployeeSync("default", a2.conversation.id, atlas)!;

  const enqueue = (laneId: string, content: string) => enqueueNativeTaskSync({
    assignee: "Atlas",
    title: content,
    priority: "medium",
    triggerType: "channel_chat",
    requestedByUserId: "user-1",
    conversationId: laneId === lane1.id ? a1.conversation.id : a2.conversation.id,
    executionLaneId: laneId,
    metadata: { channelName: "direct-atlas", channelMessage: content },
  });

  const taskA = enqueue(lane1.id, "任务 A");
  const taskB = enqueue(lane2.id, "任务 B");
  const taskC = enqueue(lane1.id, "任务 C");
  assert.ok(taskA && taskB && taskC, "三条任务都应入队");
  assert.equal(taskA!.executionLaneId, lane1.id);

  const runtimeId = getDatabase().prepare("SELECT runtime_id AS id FROM employee_runtime_binding WHERE employee_id = ? LIMIT 1")
    .get(atlas) as { id?: string } | undefined;
  const claimedA = claimNextQueuedTaskForRuntimeSync(runtimeId!.id!);
  assert.equal(claimedA?.id, taskA!.id, "先领取最早任务 A");

  const claimedB = claimNextQueuedTaskForRuntimeSync(runtimeId!.id!);
  assert.equal(claimedB?.id, taskB!.id, "不同 Lane 的 B 不受 A 阻塞，可并行领取");

  const claimedC = claimNextQueuedTaskForRuntimeSync(runtimeId!.id!);
  assert.equal(claimedC, null, "同 Lane 的 C 被运行中的 A 阻塞");
});

test("Runtime 容量门控：容量满时不领取（不同 Lane 也等待资源）", () => {
  const runtimeId = createRuntimeAndBinding("Atlas");
  upsertRuntimeTaskCapacitySync({ runtimeId, maxConcurrentTasks: 1 });
  process.env.RUNTIME_TASK_CAPACITY_ENABLED = "1";
  try {
    const atlas = createEmployeeId("Atlas");
    const conv1 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
    const conv2 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
    const lane1 = readExecutionLaneForConversationEmployeeSync("default", conv1.conversation.id, atlas)!;
    const lane2 = readExecutionLaneForConversationEmployeeSync("default", conv2.conversation.id, atlas)!;
    const enqueueOnLane = (laneId: string, content: string) => enqueueNativeTaskSync({
      assignee: "Atlas",
      title: content,
      priority: "medium",
      triggerType: "channel_chat",
      requestedByUserId: "user-1",
      conversationId: laneId === lane1.id ? conv1.conversation.id : conv2.conversation.id,
      executionLaneId: laneId,
      metadata: { channelName: "direct-atlas", channelMessage: content },
    });

    const task1 = enqueueOnLane(lane1.id, "任务 A");
    const task2 = enqueueOnLane(lane2.id, "任务 B");
    assert.ok(task1 && task2);

    const claimed1 = claimNextQueuedTaskForRuntimeSync(runtimeId);
    assert.equal(claimed1?.id, task1!.id);
    assert.equal(countActiveTasksForRuntimeSync(runtimeId), 1);
    assert.equal(isRuntimeAtCapacitySync(runtimeId), true);

    const claimed2 = claimNextQueuedTaskForRuntimeSync(runtimeId);
    assert.equal(claimed2, null, "容量满时即使不同 Lane 也不得领取");
  } finally {
    delete process.env.RUNTIME_TASK_CAPACITY_ENABLED;
  }
});

test("TASK_QUEUE_BY_CONVERSATION=off 时回到 legacy claim（不同 Lane 也按员工串行）", () => {
  const runtimeId = createRuntimeAndBinding("Atlas");
  const atlas = createEmployeeId("Atlas");
  const conv1 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  const conv2 = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  const lane1 = readExecutionLaneForConversationEmployeeSync("default", conv1.conversation.id, atlas)!;
  const lane2 = readExecutionLaneForConversationEmployeeSync("default", conv2.conversation.id, atlas)!;
  const task1 = enqueueNativeTaskSync({
    assignee: "Atlas", title: "任务 A", priority: "medium", triggerType: "channel_chat",
    requestedByUserId: "user-1", conversationId: conv1.conversation.id, executionLaneId: lane1.id,
    metadata: { channelName: "direct-atlas", channelMessage: "任务 A" },
  });
  const task2 = enqueueNativeTaskSync({
    assignee: "Atlas", title: "任务 B", priority: "medium", triggerType: "channel_chat",
    requestedByUserId: "user-1", conversationId: conv2.conversation.id, executionLaneId: lane2.id,
    metadata: { channelName: "direct-atlas", channelMessage: "任务 B" },
  });
  assert.ok(task1 && task2);

  process.env.TASK_QUEUE_BY_CONVERSATION = "off";
  try {
    const claimed1 = claimNextQueuedTaskForRuntimeSync(runtimeId);
    assert.equal(claimed1?.id, task1!.id);
    const claimed2 = claimNextQueuedTaskForRuntimeSync(runtimeId);
    assert.equal(claimed2, null, "legacy claim 下同员工不同 Lane 也串行");
  } finally {
    delete process.env.TASK_QUEUE_BY_CONVERSATION;
  }
});

test("同 Lane 互斥跨 runtime 生效（employee 重绑后不并发）", () => {
  const runtimeA = createRuntimeAndBinding("Atlas");
  const atlas = createEmployeeId("Atlas");
  const conv = createConversationSync({ employeeId: atlas, employeeName: "Atlas", createdByUserId: "user-1" });
  const lane = readExecutionLaneForConversationEmployeeSync("default", conv.conversation.id, atlas)!;

  const enqueueOnLane = (content: string) => enqueueNativeTaskSync({
    assignee: "Atlas",
    title: content,
    priority: "medium",
    triggerType: "channel_chat",
    requestedByUserId: "user-1",
    conversationId: conv.conversation.id,
    executionLaneId: lane.id,
    metadata: { channelName: "direct-atlas", channelMessage: content },
  });

  const task1 = enqueueOnLane("任务 A");
  assert.ok(task1);
  const claimedOnA = claimNextQueuedTaskForRuntimeSync(runtimeA);
  assert.equal(claimedOnA?.id, task1!.id, "runtimeA 领取任务 A");

  // 重绑 Atlas 到新 runtimeB（createRuntimeAndBinding 注册新 runtime 并 bindEmployeeRuntimeSync 重绑）。
  const runtimeB = createRuntimeAndBinding("Atlas");
  const task2 = enqueueOnLane("任务 B");
  assert.ok(task2);
  assert.notEqual(task2!.runtimeId, runtimeA, "任务 B 应落在重绑后的 runtimeB");

  // 任务 A 仍在 runtimeA 上 claimed（同 Lane），任务 B 不应被 runtimeB 领取——跨 runtime 互斥。
  const claimedOnB = claimNextQueuedTaskForRuntimeSync(runtimeB);
  assert.equal(claimedOnB, null, "同 Lane 旧任务在另一 runtime 上运行时，新 runtime 不得并发领取");
});
