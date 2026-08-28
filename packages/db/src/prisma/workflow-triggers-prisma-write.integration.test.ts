import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueWorkflowTriggersSync,
  createWorkflowDefinitionSync,
  getDatabase,
  hardDeleteWorkspaceSync,
  publishWorkflowVersionSync,
  readWorkflowTriggerSync,
  upsertWorkflowTriggerSync,
} from "../index.ts";
import { createWorkspaceSync } from "../workspaces.ts";
import { disconnectDofePrismaClient } from "./prisma-client.ts";
import { advanceWorkflowTriggerWithOutcomePrisma } from "./workflow-triggers-prisma.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

test("Prisma trigger release rolls back when scheduler audit insert fails", {
  skip: !hasTestDatabase,
}, async () => {
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = `trigger-audit-rollback-${suffix}`;
  const workflowId = `workflow-${suffix}`;
  const triggerId = `trigger-${suffix}`;
  const functionName = `test_fail_scheduler_audit_${suffix}`;
  const databaseTriggerName = `test_scheduler_audit_${suffix}`;
  const scheduledAt = "2026-08-17T00:00:00.000Z";
  const now = "2026-08-17T00:00:05.000Z";
  createWorkspaceSync({ id: workspaceId, slug: workspaceId, name: workspaceId, createdBy: "test" });

  try {
    createWorkflowDefinitionSync({
      id: workflowId,
      workspaceId,
      name: "Trigger audit rollback",
      ownerUserId: "u1",
      createdBy: "u1",
      now: scheduledAt,
    });
    publishWorkflowVersionSync({
      id: `version-${suffix}`,
      workspaceId,
      workflowId,
      graphJson: JSON.stringify({
        schemaVersion: 1,
        nodes: [{ id: "root", type: "employee_task", employeeId: "employee-1", config: {} }],
        edges: [],
      }),
      contentHash: `sha256:${suffix}`,
      publishedBy: "u1",
      now: scheduledAt,
    });
    upsertWorkflowTriggerSync({
      id: triggerId,
      workspaceId,
      workflowId,
      type: "schedule",
      configJson: '{"repeatSeconds":3600}',
      status: "active",
      nextFireAt: scheduledAt,
      now: scheduledAt,
    });
    const claimed = claimDueWorkflowTriggersSync({ workspaceId, workerId: "worker-1", now, limit: 1, leaseSeconds: 60 })[0]!;

    getDatabase().exec(`
      CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.workspace_id = '${workspaceId}' THEN
          RAISE EXCEPTION 'forced_scheduler_audit_failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${databaseTriggerName}
        BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);

    await assert.rejects(
      advanceWorkflowTriggerWithOutcomePrisma({
        id: triggerId,
        workspaceId,
        workflowId,
        workerId: "worker-1",
        nextFireAt: null,
        status: "paused",
        now,
        misfirePolicy: claimed.misfirePolicy,
        outcome: { code: "workflow.trigger.invalid", reasonCode: "workflow_schedule_invalid" },
      }),
      /forced_scheduler_audit_failure/,
    );

    const persisted = readWorkflowTriggerSync(triggerId, workspaceId)!;
    assert.equal(persisted.status, "active");
    assert.equal(persisted.nextFireAt, scheduledAt);
    assert.equal(persisted.leaseOwner, "worker-1");
    const auditCount = getDatabase().prepare(
      "SELECT COUNT(*)::integer AS count FROM audit_log WHERE workspace_id = ? AND code = 'workflow.trigger.invalid'",
    ).get(workspaceId) as { count: number };
    assert.equal(auditCount.count, 0);
  } finally {
    getDatabase().exec(`
      DROP TRIGGER IF EXISTS ${databaseTriggerName} ON audit_log;
      DROP FUNCTION IF EXISTS ${functionName}();
    `);
    await disconnectDofePrismaClient();
    hardDeleteWorkspaceSync(workspaceId);
  }
});
