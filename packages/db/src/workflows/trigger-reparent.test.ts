import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase } from "../database.ts";
import { getPostgresSchemaStatements } from "../postgres-schema.ts";
import { createWorkflowDefinitionSync, publishWorkflowVersionSync, upsertWorkflowTriggerSync } from "./definitions.ts";
import { createWorkflowRunSync, readWorkflowRunSync } from "./runs.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

/** schema 111/112 的 trigger_id 修复语句：从真实迁移清单中取，保证测试与迁移同步。 */
function findReparentStatement(): string {
  const statement = getPostgresSchemaStatements().find((candidate) => (
    candidate.includes("workflow_run") && candidate.includes("trigger_id = NULL")
  ));
  if (!statement) throw new Error("schema 111/112 reparent statement not found");
  return statement;
}

test("schema reparent fix nulls same-type and cross-type mislinks but spares correct links", {
  skip: !hasTestDatabase,
}, () => {
  const db = getDatabase();
  const suffix = Math.random().toString(36).slice(2, 8);
  const workspaceId = `workflow-reparent-${suffix}`;
  const workflowIdA = `wf-a-${suffix}`;
  const versionIdA = `wv-a-${suffix}`;
  const workflowIdB = `wf-b-${suffix}`;
  const versionIdB = `wv-b-${suffix}`;
  const triggerA = `trigger-manual-a-${suffix}`;
  const triggerB = `trigger-manual-b-${suffix}`;
  const now = new Date().toISOString();
  const emptyGraph = '{"schemaVersion":1,"nodes":[],"edges":[]}';
  try {
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run(workspaceId, workspaceId, workspaceId, now, now);
    // 两条工作流各自挂一个 manual 触发器（同类型、不同 id），用于构造同类型 reparent 误链。
    createWorkflowDefinitionSync({ id: workflowIdA, workspaceId, name: "A", ownerUserId: "u1", createdBy: "u1", now });
    publishWorkflowVersionSync({ id: versionIdA, workspaceId, workflowId: workflowIdA, graphJson: emptyGraph, contentHash: `sha256:a-${suffix}`, publishedBy: "u1", now });
    upsertWorkflowTriggerSync({ id: triggerA, workspaceId, workflowId: workflowIdA, type: "manual", configJson: "{}", status: "active", now });
    createWorkflowDefinitionSync({ id: workflowIdB, workspaceId, name: "B", ownerUserId: "u1", createdBy: "u1", now });
    publishWorkflowVersionSync({ id: versionIdB, workspaceId, workflowId: workflowIdB, graphJson: emptyGraph, contentHash: `sha256:b-${suffix}`, publishedBy: "u1", now });
    upsertWorkflowTriggerSync({ id: triggerB, workspaceId, workflowId: workflowIdB, type: "manual", configJson: "{}", status: "active", now });

    // R1 控制组：trigger_key 内嵌 A、trigger_id=A、类型一致 → 正确链接，不应置空。
    const r1 = createWorkflowRunSync({
      workspaceId, workflowId: workflowIdA, versionId: versionIdA, triggerType: "manual",
      triggerKey: `${workflowIdA}:${triggerA}:k1`, triggerId: triggerA, inputJson: "{}",
    });
    // R2 同类型误链：trigger_key 内嵌 A，但 trigger_id 被（buggy reparent）改指另一条仍存在的同类型触发器 B
    //    —— FK 合法、类型一致，故只能靠 trigger_key 的第二段识别 → 应置空。
    const r2 = createWorkflowRunSync({
      workspaceId, workflowId: workflowIdA, versionId: versionIdA, triggerType: "manual",
      triggerKey: `${workflowIdA}:${triggerA}:k2`, triggerId: triggerA, inputJson: "{}",
    });
    db.prepare("UPDATE workflow_run SET trigger_id = ? WHERE id = ?").run(triggerB, r2.id);
    // R3 跨类型误链：trigger_key 内嵌 A、trigger_id=A（一致，trigger_key 分支不触发），但 run.trigger_type 被改成 schedule
    //    与 A 的 manual 不符 → 类型分支置空。
    const r3 = createWorkflowRunSync({
      workspaceId, workflowId: workflowIdA, versionId: versionIdA, triggerType: "manual",
      triggerKey: `${workflowIdA}:${triggerA}:k3`, triggerId: triggerA, inputJson: "{}",
    });
    db.prepare("UPDATE workflow_run SET trigger_type = 'schedule' WHERE id = ?").run(r3.id);

    db.exec(findReparentStatement());

    assert.equal(readWorkflowRunSync(r1.id, workspaceId)?.triggerId, triggerA, "correct link must be preserved");
    assert.equal(readWorkflowRunSync(r2.id, workspaceId)?.triggerId, undefined, "same-type mislink must be nulled via trigger_key");
    assert.equal(readWorkflowRunSync(r3.id, workspaceId)?.triggerId, undefined, "cross-type mislink must be nulled via type check");
  } finally {
    db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
  }
});
