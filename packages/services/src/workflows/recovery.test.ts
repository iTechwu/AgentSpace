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
