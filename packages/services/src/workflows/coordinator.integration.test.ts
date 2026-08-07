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
import { completeWorkflowNodeSync, failWorkflowNodeSync } from "./coordinator.ts";

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

function cleanup(workspaceId: string): void {
  const db = getDatabase();
  // 删除 workspace 会级联清理其下的 run / node_run / event / task_queue / runtime。
  db.prepare("DELETE FROM agent_runtime WHERE workspace_id = ?").run(workspaceId);
  db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
}
