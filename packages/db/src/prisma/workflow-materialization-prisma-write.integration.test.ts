import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueWorkflowTriggersSync,
  createWorkflowDefinitionSync,
  getDatabase,
  hardDeleteWorkspaceSync,
  publishWorkflowVersionSync,
  readWorkflowRunSyncByTriggerKey,
  readWorkflowTriggerSync,
  upsertWorkflowTriggerSync,
} from "../index.ts";
import { createWorkspaceSync } from "../workspaces.ts";
import { disconnectDofePrismaClient } from "./prisma-client.ts";
import { materializeWorkflowRunPrisma } from "./workflow-materialization-prisma-write.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

test("Prisma materialization commits run, nodes, events, outbox and trigger advance atomically", {
  skip: !hasTestDatabase,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `workflow-materialize-prisma-${suffix}`;
  const workflowId = `workflow-${suffix}`;
  const triggerId = `trigger-${suffix}`;
  const scheduledAt = "2026-08-17T01:00:00.000Z";
  const now = "2026-08-17T01:00:05.000Z";
  const nextFireAt = "2026-08-17T02:00:00.000Z";
  createWorkspaceSync({ id: workspaceId, slug: workspaceId, name: workspaceId, createdBy: "test" });

  try {
    createWorkflowDefinitionSync({
      id: workflowId,
      workspaceId,
      name: "Prisma materialization",
      ownerUserId: "u1",
      createdBy: "u1",
      now,
    });
    publishWorkflowVersionSync({
      id: `version-${suffix}`,
      workspaceId,
      workflowId,
      graphJson: JSON.stringify({
        schemaVersion: 1,
        nodes: [
          { id: "root", type: "employee_task", employeeId: "employee-1", config: { retry: { maxAttempts: 3 } } },
          { id: "next", type: "approval", config: {} },
        ],
        edges: [{ source: "root", target: "next" }],
      }),
      contentHash: `sha256:${suffix}`,
      publishedBy: "u1",
      now,
    });
    upsertWorkflowTriggerSync({
      id: triggerId,
      workspaceId,
      workflowId,
      type: "schedule",
      configJson: '{"repeatSeconds":3600}',
      status: "active",
      nextFireAt: scheduledAt,
      now,
    });
    const claimed = claimDueWorkflowTriggersSync({ workspaceId, workerId: "worker-1", now, limit: 1, leaseSeconds: 60 })[0]!;

    const result = await materializeWorkflowRunPrisma({
      workspaceId,
      trigger: claimed,
      scheduledAt,
      now,
      triggerAdvance: { workerId: "worker-1", nextFireAt },
    });

    assert.equal(result.created, true);
    const run = readWorkflowRunSyncByTriggerKey(workspaceId, `${workflowId}:${triggerId}:${scheduledAt}`)!;
    assert.equal(run.id, result.runId);
    assert.equal(run.status, "queued");
    assert.equal(run.currentSequence, 2);
    const nodes = getDatabase().prepare(
      "SELECT node_id AS id, status, max_attempts AS \"maxAttempts\" FROM workflow_node_run WHERE run_id = ? ORDER BY node_id",
    ).all(run.id) as Array<{ id: string; status: string; maxAttempts: number }>;
    assert.deepEqual(nodes, [
      { id: "next", status: "pending", maxAttempts: 1 },
      { id: "root", status: "ready", maxAttempts: 3 },
    ]);
    assert.deepEqual(
      (getDatabase().prepare("SELECT type FROM workflow_run_event WHERE run_id = ? ORDER BY sequence").all(run.id) as Array<{ type: string }>).map((row) => row.type),
      ["run.created", "trigger.fired"],
    );
    assert.equal(
      (getDatabase().prepare("SELECT COUNT(*)::integer AS count FROM workflow_outbox WHERE aggregate_id = ? AND event_type = 'workflow.run.ready'").get(run.id) as { count: number }).count,
      1,
    );
    const advanced = readWorkflowTriggerSync(triggerId, workspaceId)!;
    assert.equal(advanced.nextFireAt, nextFireAt);
    assert.equal(advanced.lastFireAt, scheduledAt);
    assert.equal(advanced.leaseOwner, undefined);
  } finally {
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(workspaceId);
  }
});

test("Prisma materialization rolls every write back when trigger advance loses its lease", {
  skip: !hasTestDatabase,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `workflow-materialize-rollback-${suffix}`;
  const workflowId = `workflow-${suffix}`;
  const triggerId = `trigger-${suffix}`;
  const scheduledAt = "2026-08-17T03:00:00.000Z";
  createWorkspaceSync({ id: workspaceId, slug: workspaceId, name: workspaceId, createdBy: "test" });
  try {
    createWorkflowDefinitionSync({ id: workflowId, workspaceId, name: "Rollback", ownerUserId: "u1", createdBy: "u1", now: scheduledAt });
    publishWorkflowVersionSync({
      id: `version-${suffix}`,
      workspaceId,
      workflowId,
      graphJson: '{"schemaVersion":1,"nodes":[{"id":"root","type":"employee_task","config":{}}],"edges":[]}',
      contentHash: `sha256:${suffix}`,
      publishedBy: "u1",
      now: scheduledAt,
    });
    upsertWorkflowTriggerSync({ id: triggerId, workspaceId, workflowId, type: "schedule", configJson: "{}", status: "active", nextFireAt: scheduledAt, now: scheduledAt });
    const claimed = claimDueWorkflowTriggersSync({ workspaceId, workerId: "worker-1", now: scheduledAt, limit: 1, leaseSeconds: 60 })[0]!;
    const baselineOutboxCount = (getDatabase().prepare(
      "SELECT COUNT(*)::integer AS count FROM workflow_outbox WHERE workspace_id = ?",
    ).get(workspaceId) as { count: number }).count;

    await assert.rejects(materializeWorkflowRunPrisma({
      workspaceId,
      trigger: claimed,
      scheduledAt,
      now: scheduledAt,
      triggerAdvance: { workerId: "wrong-worker", nextFireAt: null },
    }), /workflow_trigger_lease_conflict/);
    assert.equal(readWorkflowRunSyncByTriggerKey(workspaceId, `${workflowId}:${triggerId}:${scheduledAt}`), null);
    assert.equal((getDatabase().prepare("SELECT COUNT(*)::integer AS count FROM workflow_node_run WHERE workspace_id = ?").get(workspaceId) as { count: number }).count, 0);
    assert.equal(
      (getDatabase().prepare("SELECT COUNT(*)::integer AS count FROM workflow_outbox WHERE workspace_id = ?").get(workspaceId) as { count: number }).count,
      baselineOutboxCount,
    );
  } finally {
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(workspaceId);
  }
});
