import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase } from "../database.ts";
import { createWorkspaceSync, hardDeleteWorkspaceSync } from "../workspaces.ts";
import { createWorkflowDefinitionSync, publishWorkflowVersionSync } from "../workflows/definitions.ts";
import { createWorkflowRunSync, materializeWorkflowNodeRunsSync, readWorkflowNodeRunSync } from "../workflows/runs.ts";
import { disconnectDofePrismaClient } from "./prisma-client.ts";
import { readyWorkflowNodeWithOutboxPrisma } from "./workflow-coordinator-prisma-write.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

function seedPendingNode(suffix: string): { workspaceId: string; runId: string; nodeRunId: string } {
  const workspaceId = `workflow-coordinator-prisma-${suffix}`;
  createWorkspaceSync({ id: workspaceId, slug: workspaceId, name: workspaceId, createdBy: "test" });
  const definition = createWorkflowDefinitionSync({
    id: `workflow-${suffix}`,
    workspaceId,
    name: "Coordinator Prisma",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const version = publishWorkflowVersionSync({
    id: `version-${suffix}`,
    workspaceId,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: `sha256:${suffix}`,
    publishedBy: "u1",
  });
  const run = createWorkflowRunSync({
    workspaceId,
    workflowId: definition.id,
    versionId: version.id,
    triggerType: "manual",
    triggerKey: `coordinator:${suffix}`,
    inputJson: "{}",
  });
  const node = materializeWorkflowNodeRunsSync({
    workspaceId,
    runId: run.id,
    nodes: [{ nodeId: "downstream", nodeType: "employee_task", inputJson: "{}" }],
  })[0]!;
  return { workspaceId, runId: run.id, nodeRunId: node.id };
}

test("coordinator Prisma primitive commits pending-to-ready and node.ready outbox together", {
  skip: !hasTestDatabase,
}, async () => {
  const fixture = seedPendingNode(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const now = "2026-08-17T05:00:00.000Z";
  try {
    const result = await readyWorkflowNodeWithOutboxPrisma({
      ...fixture,
      inputJson: { brief: "resolved" },
      now,
    });
    assert.equal(result.transitioned, true);
    const node = readWorkflowNodeRunSync(fixture.nodeRunId, fixture.workspaceId)!;
    assert.equal(node.status, "ready");
    assert.equal(node.availableAt, now);
    assert.deepEqual(JSON.parse(node.inputJson), { brief: "resolved" });
    assert.equal(
      (getDatabase().prepare("SELECT COUNT(*)::integer AS count FROM workflow_outbox WHERE aggregate_id = ? AND event_type = 'workflow.node.ready'").get(fixture.nodeRunId) as { count: number }).count,
      1,
    );
  } finally {
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(fixture.workspaceId);
  }
});

test("coordinator Prisma primitive rolls node state back when outbox insert fails", {
  skip: !hasTestDatabase,
}, async () => {
  const fixture = seedPendingNode(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const outboxId = `workflow-outbox-conflict-${Math.random().toString(36).slice(2, 8)}`;
  const now = "2026-08-17T05:30:00.000Z";
  getDatabase().prepare(
    `INSERT INTO workflow_outbox (id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json, status, attempts, available_at, created_at)
     VALUES (?, ?, 'test', ?, 'test.conflict', '{}', 'pending', 0, ?, ?)`,
  ).run(outboxId, fixture.workspaceId, fixture.runId, now, now);
  try {
    await assert.rejects(readyWorkflowNodeWithOutboxPrisma({
      ...fixture,
      inputJson: { brief: "must-rollback" },
      outboxId,
      now,
    }));
    const node = readWorkflowNodeRunSync(fixture.nodeRunId, fixture.workspaceId)!;
    assert.equal(node.status, "pending");
    assert.deepEqual(JSON.parse(node.inputJson), {});
  } finally {
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(fixture.workspaceId);
  }
});
