import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowDefinitionSync,
  createWorkflowRunSync,
  enqueueWorkflowOutboxSync,
  getDatabase,
  materializeWorkflowNodeRunsSync,
  publishWorkflowVersionSync,
  transitionWorkflowNodeRunSync,
} from "@dofe-agent/db";
import { recoverStaleWorkflowWorkSync } from "./recovery.ts";

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
function seedWorkspace(): Seed {
  const suffix = Math.random().toString(36).slice(2, 10);
  const workspaceId = `workflow-recovery-${suffix}`;
  const workflowId = `workflow-definition-${suffix}`;
  const versionId = `workflow-version-${suffix}`;
  const now = "2026-08-07T01:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  const graphJson = JSON.stringify({
    schemaVersion: 1,
    nodes: [{ id: "a", type: "employee_task", employeeId: "emp-a", config: {} }],
    edges: [],
  });
  createWorkflowDefinitionSync({
    id: workflowId,
    workspaceId,
    name: "Recovery test",
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

test("recoverStaleWorkflowWorkSync re-enqueues a dead-lettered ready node (Spec #5)", {
  skip: !hasTestDatabase,
}, () => {
  // workflow.node.ready 的 outbox 派发耗尽 8 次后进入 dead_letter，节点此前永久卡 ready：
  // recovery 只扫 retry_wait/queued，不扫 ready。修复后 recovery 应为「仍为 ready、存在
  // dead_letter 派发记录、且无 pending 派发」的节点重新入队一条 outbox。
  const seed = seedWorkspace();
  const now = "2026-08-07T01:00:00.000Z";
  const run = createWorkflowRunSync({
    workspaceId: seed.workspaceId,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: `recovery:deadletter-${seed.workspaceId}`,
    inputJson: "{}",
  });
  const nodes = materializeWorkflowNodeRunsSync({
    workspaceId: seed.workspaceId,
    runId: run.id,
    nodes: [{ nodeId: "a", nodeType: "employee_task", employeeId: "emp-a" }],
  });
  const node = nodes[0]!;
  // 节点进入 ready（等待派发）。
  transitionWorkflowNodeRunSync({
    workspaceId: seed.workspaceId,
    nodeRunId: node.id,
    from: ["pending"],
    to: "ready",
    now,
  });
  // 模拟派发 8 次失败后的 dead_letter 记录。
  getDatabase().prepare(
    `INSERT INTO workflow_outbox (
       id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json,
       status, attempts, available_at, created_at
     ) VALUES (?, ?, 'workflow_node_run', ?, 'workflow.node.ready', ?, 'dead_letter', 8, ?, ?)`,
  ).run(
    `outbox-deadletter-${node.id}`,
    seed.workspaceId,
    node.id,
    JSON.stringify({ nodeRunId: node.id }),
    now,
    now,
  );

  const result = recoverStaleWorkflowWorkSync({ now, workerId: "recovery-worker", limit: 10 });

  assert.ok(
    result.requeuedReadyNodeRunIds.includes(node.id),
    "死信 ready 节点须被重新入队",
  );
  const pending = getDatabase().prepare(
    `SELECT COUNT(*)::int AS count FROM workflow_outbox
      WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'workflow.node.ready' AND status = 'pending'`,
  ).get(seed.workspaceId, node.id) as { count?: number } | undefined;
  assert.equal(Number(pending?.count), 1, "应新产生一条 pending 派发记录");

  // 幂等：再次扫描时已存在 pending，不应重复入队。
  const result2 = recoverStaleWorkflowWorkSync({ now, workerId: "recovery-worker", limit: 10 });
  assert.deepEqual(result2.requeuedReadyNodeRunIds, [], "存在 pending 时不得重复入队");
  const pendingAfter = getDatabase().prepare(
    `SELECT COUNT(*)::int AS count FROM workflow_outbox
      WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'workflow.node.ready' AND status = 'pending'`,
  ).get(seed.workspaceId, node.id) as { count?: number } | undefined;
  assert.equal(Number(pendingAfter?.count), 1, "二次扫描后仍只有一条 pending");
});

test("recoverStaleWorkflowWorkSync fails a ready node after repeated dead-letter (bounded retry, no infinite reset)", {
  skip: !hasTestDatabase,
}, () => {
  // 死信自愈必须终结「8 次失败→重新入队→再 8 次」的无限重置循环：第一条死信重新入队（给予一次新预算），
  // 累计 >= 2 条死信（重新入队后再次耗尽）则永久失败该节点，而非再次以 attempts=0 入队。
  const seed = seedWorkspace();
  const now = "2026-08-07T01:00:00.000Z";
  const run = createWorkflowRunSync({
    workspaceId: seed.workspaceId,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: `recovery:bounded-${seed.workspaceId}`,
    inputJson: "{}",
  });
  const nodes = materializeWorkflowNodeRunsSync({
    workspaceId: seed.workspaceId,
    runId: run.id,
    nodes: [{ nodeId: "a", nodeType: "employee_task", employeeId: "emp-a" }],
  });
  const node = nodes[0]!;
  transitionWorkflowNodeRunSync({
    workspaceId: seed.workspaceId,
    nodeRunId: node.id,
    from: ["pending"],
    to: "ready",
    now,
  });
  // 两条 dead_letter → deadLetterCount = 2 → 永久失败（模拟重新入队后再次耗尽 8 次）。
  const insertDeadLetter = (suffix: string) =>
    getDatabase().prepare(
      `INSERT INTO workflow_outbox (
         id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json,
         status, attempts, available_at, created_at
       ) VALUES (?, ?, 'workflow_node_run', ?, 'workflow.node.ready', ?, 'dead_letter', 8, ?, ?)`,
    ).run(
      `outbox-bounded-${node.id}-${suffix}`,
      seed.workspaceId,
      node.id,
      JSON.stringify({ nodeRunId: node.id }),
      now,
      now,
    );
  insertDeadLetter("first");
  insertDeadLetter("second");

  const result = recoverStaleWorkflowWorkSync({ now, workerId: "recovery-worker", limit: 10 });

  // 节点被永久失败，而非再次重新入队。
  assert.ok(result.failedNodeRunIds.includes(node.id), "累计 >= 2 条死信的节点须被永久失败");
  assert.ok(!result.requeuedReadyNodeRunIds.includes(node.id), "不得再次重置重试预算重新入队");
  const pending = getDatabase().prepare(
    `SELECT COUNT(*)::int AS count FROM workflow_outbox
      WHERE workspace_id = ? AND aggregate_id = ? AND event_type = 'workflow.node.ready' AND status = 'pending'`,
  ).get(seed.workspaceId, node.id) as { count?: number } | undefined;
  assert.equal(Number(pending?.count), 0, "永久失败后不得产生新的 pending 派发");
  const failedNode = getDatabase().prepare(
    `SELECT status, error_code AS "errorCode" FROM workflow_node_run WHERE workspace_id = ? AND id = ?`,
  ).get(seed.workspaceId, node.id) as { status?: string; errorCode?: string } | undefined;
  assert.equal(failedNode?.status, "failed", "节点状态须为 failed");
  assert.equal(failedNode?.errorCode, "workflow_ready_dispatch_exhausted", "失败原因须为派发预算耗尽");

  // 幂等：再次扫描不再产生任何动作（节点已 failed，不在 ready 扫描集）。
  const result2 = recoverStaleWorkflowWorkSync({ now, workerId: "recovery-worker", limit: 10 });
  assert.deepEqual(result2.failedNodeRunIds, [], "已失败节点不得重复处理");
  assert.deepEqual(result2.requeuedReadyNodeRunIds, [], "已失败节点不得重新入队");
});
