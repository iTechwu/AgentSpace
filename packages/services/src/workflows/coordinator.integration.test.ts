import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowDefinitionSync,
  createWorkflowRunSync,
  getDatabase,
  listWorkflowRunEventsSync,
  materializeWorkflowNodeRunsSync,
  publishWorkflowVersionSync,
  readWorkflowRunSync,
  transitionWorkflowNodeRunSync,
} from "@dofe-agent/db";
import { completeWorkflowApprovalNodeSync, completeWorkflowNodeSync, failWorkflowNodeSync } from "./coordinator.ts";
import { startQueuedTaskWithWorkflowSync } from "./completion.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

interface Seed {
  workspaceId: string;
  workflowId: string;
  versionId: string;
}

/** 在独立工作区内种入一条带单个 employee_task 节点的已发布版本。 */
function seedWorkspace(graphJson: string, nodeCount: number): Seed {
  const suffix = Math.random().toString(36).slice(2, 10);
  const workspaceId = `workflow-coordinator-${suffix}`;
  const workflowId = `workflow-definition-${suffix}`;
  const versionId = `workflow-version-${suffix}`;
  const now = "2026-08-07T01:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  createWorkflowDefinitionSync({
    id: workflowId,
    workspaceId,
    name: "Coordinator events",
    ownerUserId: "u1",
    createdBy: "u1",
    now,
  });
  publishWorkflowVersionSync({
    id: versionId,
    workspaceId,
    workflowId,
    graphJson,
    contentHash: `sha256:${suffix}`,
    publishedBy: "u1",
    now,
  });
  return { workspaceId, workflowId, versionId };
}

/** agent_task_queue 需要 agent_runtime 外键，这里一并种入并返回任务 id。 */
function seedQueuedTask(workspaceId: string, suffix: string): string {
  const now = "2026-08-07T01:00:00.000Z";
  const runtimeId = `runtime-${suffix}`;
  const taskId = `task-${suffix}`;
  const db = getDatabase();
  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, ?, 'codex', ?, 'active', ?, ?)`,
  ).run(runtimeId, workspaceId, runtimeId, now, now);
  db.prepare(
    `INSERT INTO agent_task_queue (id, workspace_id, agent_id, runtime_id, status, priority, input_json, queued_at, created_at, updated_at)
     VALUES (?, ?, 'agent-coordinator', ?, 'queued', 0, '{}', ?, ?, ?)`,
  ).run(taskId, workspaceId, runtimeId, now, now, now);
  return taskId;
}

test("run.started and run.succeeded are emitted across the run lifecycle", {
  skip: !hasTestDatabase,
}, () => {
  // 两节点线性图：完成 A 时仍有 B 在执行 → 触发 run.started；完成 B 后整体终态 → run.succeeded。
  const graphJson = JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "a", type: "employee_task", employeeId: "emp-a", config: {} },
      { id: "b", type: "employee_task", employeeId: "emp-b", config: {} },
    ],
    edges: [{ source: "a", target: "b" }],
  });
  const seed = seedWorkspace(graphJson, 2);
  try {
    const run = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "manual",
      triggerKey: `coordinator:lifecycle-${seed.workspaceId}`,
      inputJson: "{}",
    });
    const nodes = materializeWorkflowNodeRunsSync({
      workspaceId: seed.workspaceId,
      runId: run.id,
      nodes: [
        { nodeId: "a", nodeType: "employee_task", employeeId: "emp-a" },
        { nodeId: "b", nodeType: "employee_task", employeeId: "emp-b" },
      ],
    });
    const byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
    const taskA = seedQueuedTask(seed.workspaceId, `${seed.workspaceId}-a`);
    transitionWorkflowNodeRunSync({
      workspaceId: seed.workspaceId,
      nodeRunId: byNodeId.get("a")!.id,
      from: ["pending"],
      to: "queued",
      taskQueueId: taskA,
    });

    // 完成 A：仍有 B 处于活跃态，finalizeRunIfTerminal 将 run 推进到 running 并补发 run.started。
    completeWorkflowNodeSync({
      workspaceId: seed.workspaceId,
      nodeRunId: byNodeId.get("a")!.id,
      taskQueueId: taskA,
      output: { ok: true },
    });
    let types = listWorkflowRunEventsSync(seed.workspaceId, run.id).map((event) => event.type);
    assert.ok(types.includes("run.started"), `expected run.started in ${JSON.stringify(types)}`);
    assert.equal(readWorkflowRunSync(run.id, seed.workspaceId)?.status, "running");

    // 排队并完成 B：无活跃节点，run 进入终态 succeeded 并补发 run.succeeded。
    const taskB = seedQueuedTask(seed.workspaceId, `${seed.workspaceId}-b`);
    // advanceDownstream 已将 B 置为 ready，这里直接转 queued 以便完成。
    transitionWorkflowNodeRunSync({
      workspaceId: seed.workspaceId,
      nodeRunId: byNodeId.get("b")!.id,
      from: ["ready"],
      to: "queued",
      taskQueueId: taskB,
    });
    completeWorkflowNodeSync({
      workspaceId: seed.workspaceId,
      nodeRunId: byNodeId.get("b")!.id,
      taskQueueId: taskB,
      output: { ok: true },
    });
    types = listWorkflowRunEventsSync(seed.workspaceId, run.id).map((event) => event.type);
    assert.ok(types.includes("run.succeeded"), `expected run.succeeded in ${JSON.stringify(types)}`);
    assert.equal(types[types.length - 1], "run.succeeded");
    assert.equal(readWorkflowRunSync(run.id, seed.workspaceId)?.status, "succeeded");
    // run.started 只应出现一次（幂等）。
    assert.equal(types.filter((type) => type === "run.started").length, 1);
  } finally {
    cleanup(seed.workspaceId);
  }
});

test("run.started is emitted on the real daemon start path (startQueuedTaskWithWorkflowSync)", {
  skip: !hasTestDatabase,
}, () => {
  // 单节点图：daemon 领取 queued 任务并调用 startQueuedTaskWithWorkflowSync 时，
  // run 首次由 created → running 的真实启动路径必须补发 run.started（原先只在
  // finalizeRunIfTerminal 兜底补发，节点完成时才触发，导致生命周期事实事件缺失）。
  const graphJson = JSON.stringify({
    schemaVersion: 1,
    nodes: [{ id: "solo", type: "employee_task", employeeId: "emp-a", config: {} }],
    edges: [],
  });
  const seed = seedWorkspace(graphJson, 1);
  try {
    const run = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "manual",
      triggerKey: `coordinator:realstart-${seed.workspaceId}`,
      inputJson: "{}",
    });
    const [node] = materializeWorkflowNodeRunsSync({
      workspaceId: seed.workspaceId,
      runId: run.id,
      nodes: [{ nodeId: "solo", nodeType: "employee_task", employeeId: "emp-a" }],
    });
    const taskId = seedQueuedTask(seed.workspaceId, `${seed.workspaceId}-solo`);
    transitionWorkflowNodeRunSync({
      workspaceId: seed.workspaceId,
      nodeRunId: node!.id,
      from: ["pending"],
      to: "queued",
      taskQueueId: taskId,
    });

    // daemon 真实启动：此时 run 仍为 created，应在此处推进到 running 并补发 run.started。
    const result = startQueuedTaskWithWorkflowSync({ workspaceId: seed.workspaceId, taskQueueId: taskId });
    assert.equal(result.startedNow, true);
    assert.equal(result.ignored, false);
    assert.equal(readWorkflowRunSync(run.id, seed.workspaceId)?.status, "running");

    const types = listWorkflowRunEventsSync(seed.workspaceId, run.id).map((event) => event.type);
    assert.ok(types.includes("run.started"), `expected run.started in ${JSON.stringify(types)}`);
    assert.equal(types.filter((type) => type === "run.started").length, 1, "run.started must be emitted exactly once");
    // node.started 同样在真实启动路径补发。
    assert.ok(types.includes("node.started"), `expected node.started in ${JSON.stringify(types)}`);

    // 再次启动同一任务：node 已是 running，run 已是 running，幂等返回且不再重复发 run.started。
    startQueuedTaskWithWorkflowSync({ workspaceId: seed.workspaceId, taskQueueId: taskId });
    const typesAfterRepeat = listWorkflowRunEventsSync(seed.workspaceId, run.id).map((event) => event.type);
    assert.equal(typesAfterRepeat.filter((type) => type === "run.started").length, 1, "run.started must not be duplicated on repeat start");
  } finally {
    cleanup(seed.workspaceId);
  }
});

test("run.failed is emitted when an exhausted node drives the run to a terminal failure", {
  skip: !hasTestDatabase,
}, () => {
  const graphJson = JSON.stringify({
    schemaVersion: 1,
    nodes: [{ id: "solo", type: "employee_task", employeeId: "emp-solo", config: {} }],
    edges: [],
  });
  const seed = seedWorkspace(graphJson, 1);
  try {
    const run = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "manual",
      triggerKey: `coordinator:failure-${seed.workspaceId}`,
      inputJson: "{}",
    });
    const [node] = materializeWorkflowNodeRunsSync({
      workspaceId: seed.workspaceId,
      runId: run.id,
      nodes: [{ nodeId: "solo", nodeType: "employee_task", employeeId: "emp-solo" }],
    });
    const taskId = seedQueuedTask(seed.workspaceId, seed.workspaceId);
    transitionWorkflowNodeRunSync({
      workspaceId: seed.workspaceId,
      nodeRunId: node!.id,
      from: ["pending"],
      to: "queued",
      taskQueueId: taskId,
    });

    // materialize 后 attempt_count=1、max_attempts=1，单次失败即耗尽预算 → run 终态 failed。
    failWorkflowNodeSync({
      workspaceId: seed.workspaceId,
      nodeRunId: node!.id,
      taskQueueId: taskId,
      errorCode: "workflow_employee_task_failed",
      errorMessage: "boom",
    });
    const types = listWorkflowRunEventsSync(seed.workspaceId, run.id).map((event) => event.type);
    assert.ok(types.includes("run.failed"), `expected run.failed in ${JSON.stringify(types)}`);
    assert.equal(types[types.length - 1], "run.failed");
    assert.equal(readWorkflowRunSync(run.id, seed.workspaceId)?.status, "failed");
  } finally {
    cleanup(seed.workspaceId);
  }
});

test("approval rejection defers when a sibling task is mid-commit (Issue 4)", {
  skip: !hasTestDatabase,
}, () => {
  // 审批驳回遇兄弟节点任务处于 preparing_commit/committed（EAD §7 提交拆分中间态/不可逆点）时，
  // 不得终止 Run——否则 committed 产物已落盘却被标 cancelled、Run 标 failed，造成矛盾。
  // 与 cancelWorkflowRunSync 一致：抛 workflow_run_commit_in_progress，事务回滚，调用方短暂窗口后重试。
  const graphJson = JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "apr", type: "approval", config: { policy: "all_success" } },
      { id: "sib", type: "employee_task", employeeId: "emp-sib", config: {} },
    ],
    edges: [],
  });
  const seed = seedWorkspace(graphJson, 2);
  const now = "2026-08-07T01:00:00.000Z";
  const db = getDatabase();
  try {
    const run = createWorkflowRunSync({
      workspaceId: seed.workspaceId,
      workflowId: seed.workflowId,
      versionId: seed.versionId,
      triggerType: "manual",
      triggerKey: `issue4:${seed.workspaceId}`,
      inputJson: "{}",
    });
    const nodes = materializeWorkflowNodeRunsSync({
      workspaceId: seed.workspaceId,
      runId: run.id,
      nodes: [
        { nodeId: "apr", nodeType: "approval" },
        { nodeId: "sib", nodeType: "employee_task", employeeId: "emp-sib" },
      ],
    });
    const approvalNode = nodes.find((n) => n.nodeId === "apr")!;
    const siblingNode = nodes.find((n) => n.nodeId === "sib")!;

    // 兄弟节点绑定的任务推进到 preparing_commit（提交拆分中间态）。
    const taskId = seedQueuedTask(seed.workspaceId, `issue4-${Math.random().toString(36).slice(2, 6)}`);
    transitionWorkflowNodeRunSync({
      workspaceId: seed.workspaceId,
      nodeRunId: siblingNode.id,
      from: ["pending"],
      to: "running",
      taskQueueId: taskId,
      startedAt: now,
      now,
    });
    db.prepare("UPDATE agent_task_queue SET status = 'preparing_commit', updated_at = ? WHERE id = ?").run(now, taskId);

    // 审批节点进入 waiting_approval 并绑定 approval_id。
    const approvalId = `approval-issue4-${Math.random().toString(36).slice(2, 8)}`;
    transitionWorkflowNodeRunSync({
      workspaceId: seed.workspaceId,
      nodeRunId: approvalNode.id,
      from: ["pending"],
      to: "waiting_approval",
      approvalId,
      now,
    });

    // 驳回须抛 workflow_run_commit_in_progress（事务回滚：不标 cancelled、不 fail run）。
    assert.throws(
      () => completeWorkflowApprovalNodeSync({
        workspaceId: seed.workspaceId,
        approvalId,
        approved: false,
        actorUserId: "u1",
        now,
      }),
      /workflow_run_commit_in_progress/,
    );

    // 回滚后：兄弟节点仍 running（未被标 cancelled），任务仍 preparing_commit。
    const siblingAfter = db.prepare("SELECT status FROM workflow_node_run WHERE id = ?").get(siblingNode.id) as { status: string };
    assert.equal(siblingAfter.status, "running", "提交窗口期不得把 preparing_commit/committed 兄弟节点标 cancelled");
    const taskAfter = db.prepare("SELECT status FROM agent_task_queue WHERE id = ?").get(taskId) as { status: string };
    assert.equal(taskAfter.status, "preparing_commit", "任务状态不得被驳回改动");
    assert.notEqual(readWorkflowRunSync(run.id, seed.workspaceId)?.status, "failed", "Run 不得在提交窗口期被标 failed");
  } finally {
    cleanup(seed.workspaceId);
  }
});

function cleanup(workspaceId: string): void {
  const db = getDatabase();
  // 删除 workspace 会级联清理其下的 run / node_run / event / task_queue / runtime。
  db.prepare("DELETE FROM agent_runtime WHERE workspace_id = ?").run(workspaceId);
  db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
}
