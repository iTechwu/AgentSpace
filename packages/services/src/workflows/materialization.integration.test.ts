import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueWorkflowTriggersSync,
  createWorkflowDefinitionSync,
  getDatabase,
  listWorkflowRunEventsSync,
  publishWorkflowVersionSync,
  readWorkflowRunSyncByTriggerKey,
  readWorkflowTriggerSync,
  upsertWorkflowTriggerSync,
} from "@dofe-agent/db";
import { materializeWorkflowRunSync } from "./materialization.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

test("schedule materialization atomically advances the trigger and records trigger.fired", {
  skip: !hasTestDatabase,
}, () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const workspaceId = `workflow-materialization-${suffix}`;
  const workflowId = `workflow-definition-${suffix}`;
  const triggerId = `workflow-trigger-${suffix}`;
  const scheduledAt = "2026-08-07T01:00:00.000Z";
  const now = "2026-08-07T01:00:05.000Z";
  const nextFireAt = "2026-08-07T02:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);

  try {
    createWorkflowDefinitionSync({
      id: workflowId,
      workspaceId,
      name: "Atomic scheduler",
      ownerUserId: "u1",
      createdBy: "u1",
      now,
    });
    publishWorkflowVersionSync({
      workspaceId,
      workflowId,
      graphJson: '{"schemaVersion":1,"nodes":[{"id":"employee","type":"employee_task","employeeId":"emp-1","config":{}}],"edges":[]}',
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
    const materialized = materializeWorkflowRunSync({
      workspaceId,
      trigger: claimed,
      scheduledAt,
      now,
      triggerAdvance: { workerId: "worker-1", nextFireAt },
    });

    const advanced = readWorkflowTriggerSync(triggerId, workspaceId)!;
    assert.equal(advanced.nextFireAt, nextFireAt);
    assert.equal(advanced.lastFireAt, scheduledAt);
    assert.equal(advanced.leaseOwner, undefined);
    assert.deepEqual(
      listWorkflowRunEventsSync(workspaceId, materialized.runId).map((event) => event.type),
      ["run.created", "trigger.fired"],
    );
    const triggerEvent = listWorkflowRunEventsSync(workspaceId, materialized.runId)[1]!;
    assert.deepEqual(JSON.parse(triggerEvent.dataJson), {
      triggerId,
      scheduledAt,
      nextFireAt,
      misfirePolicy: "skip",
      misfired: false,
    });

    const rollbackScheduledAt = "2026-08-07T02:00:00.000Z";
    const reclaimed = claimDueWorkflowTriggersSync({
      workspaceId,
      workerId: "worker-2",
      now: rollbackScheduledAt,
      limit: 1,
      leaseSeconds: 60,
    })[0]!;
    assert.throws(() => materializeWorkflowRunSync({
      workspaceId,
      trigger: reclaimed,
      scheduledAt: rollbackScheduledAt,
      now: rollbackScheduledAt,
      triggerAdvance: { workerId: "wrong-worker", nextFireAt: "2026-08-07T03:00:00.000Z" },
    }), /workflow_trigger_lease_conflict/);
    assert.equal(
      readWorkflowRunSyncByTriggerKey(workspaceId, `${workflowId}:${triggerId}:${rollbackScheduledAt}`),
      null,
    );
  } finally {
    db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
  }
});
