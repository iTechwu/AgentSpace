import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getDatabase, resetDatabaseForTests } from "../database.ts";
import { createWorkflowDefinitionSync, publishWorkflowVersionSync } from "./definitions.ts";
import {
  createWorkflowRunSync,
  listWorkflowNodeRunsSync,
  materializeWorkflowNodeRunsSync,
  readWorkflowNodeRunSync,
  readWorkflowRunSync,
  transitionWorkflowRunSync,
  transitionWorkflowNodeRunSync,
} from "./runs.ts";
import { appendWorkflowRunEventSync, listWorkflowRunEventsSync } from "./events.ts";
import {
  claimWorkflowOutboxBatchSync,
  enqueueWorkflowOutboxSync,
  markWorkflowOutboxPublishedSync,
} from "./outbox.ts";

const WORKSPACE_ID = "workflow-runs-test";

before(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID, now, now);
});

after(() => {
  getDatabase().prepare("DELETE FROM workspace WHERE id = ?").run(WORKSPACE_ID);
  resetDatabaseForTests();
});

function seedVersion(): { workflowId: string; versionId: string } {
  const suffix = Math.random().toString(36).slice(2, 8);
  const workflowId = `workflow-runs-definition-${suffix}`;
  const versionId = `workflow-runs-version-${suffix}`;
  const definition = createWorkflowDefinitionSync({
    id: workflowId,
    workspaceId: WORKSPACE_ID,
    name: "Runs",
    ownerUserId: "u1",
    createdBy: "u1",
  });
  const version = publishWorkflowVersionSync({
    id: versionId,
    workspaceId: WORKSPACE_ID,
    workflowId: definition.id,
    graphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
    contentHash: "sha256:runs",
    publishedBy: "u1",
  });
  return { workflowId: definition.id, versionId: version.id };
}

test("materializes one run for a duplicate trigger key and protects terminal node runs", () => {
  const seed = seedVersion();
  const first = createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "schedule",
    triggerKey: "workflow-runs:slot-1",
    inputJson: "{}",
  });
  const second = createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "schedule",
    triggerKey: "workflow-runs:slot-1",
    inputJson: "{}",
  });
  assert.equal(second.id, first.id);

  const nodes = materializeWorkflowNodeRunsSync({
    workspaceId: WORKSPACE_ID,
    runId: first.id,
    nodes: [{ nodeId: "employee", nodeType: "employee_task", employeeId: "e1" }],
  });
  const node = nodes[0]!;
  assert.ok(transitionWorkflowNodeRunSync({
    workspaceId: WORKSPACE_ID,
    nodeRunId: node.id,
    from: ["pending"],
    to: "succeeded",
    outputJson: '{"ok":true}',
  }));
  assert.equal(transitionWorkflowNodeRunSync({
    workspaceId: WORKSPACE_ID,
    nodeRunId: node.id,
    from: ["succeeded"],
    to: "running",
  }), null);
  assert.equal(readWorkflowNodeRunSync(node.id, WORKSPACE_ID)?.status, "succeeded");
  assert.equal(transitionWorkflowNodeRunSync({
    workspaceId: WORKSPACE_ID,
    nodeRunId: node.id,
    from: ["succeeded"],
    to: "retry_wait",
    allowTerminalRetry: true,
  }), null, "only failed nodes may use the explicit retry transition");
  assert.equal(listWorkflowNodeRunsSync(WORKSPACE_ID, first.id).length, 1);

  assert.ok(transitionWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    runId: first.id,
    from: ["created"],
    to: "failed",
  }));
  assert.equal(transitionWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    runId: first.id,
    from: ["failed"],
    to: "running",
  }), null);
  assert.ok(transitionWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    runId: first.id,
    from: ["failed"],
    to: "running",
    allowTerminalRetry: true,
  }));
  assert.equal(readWorkflowRunSync(first.id, WORKSPACE_ID)?.status, "running");
});

test("event sequence and outbox lease are monotonic and owned", () => {
  const seed = seedVersion();
  const run = createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: "workflow-runs:event-1",
    inputJson: "{}",
  });
  assert.equal(appendWorkflowRunEventSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    type: "run.created",
    actorType: "system",
  }).sequence, 1);
  assert.equal(appendWorkflowRunEventSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    type: "run.queued",
    actorType: "system",
  }).sequence, 2);
  assert.deepEqual(listWorkflowRunEventsSync(WORKSPACE_ID, run.id).map((event) => event.sequence), [1, 2]);
  assert.deepEqual(
    listWorkflowRunEventsSync(WORKSPACE_ID, run.id, { after: 1, limit: 1 }).map((event) => event.sequence),
    [2],
  );

  const outbox = enqueueWorkflowOutboxSync({
    workspaceId: WORKSPACE_ID,
    aggregateType: "workflow_run",
    aggregateId: run.id,
    eventType: "workflow.run.created",
    payloadJson: "{}",
    now: "2026-08-07T00:00:00.000Z",
  });
  const claimed = claimWorkflowOutboxBatchSync({
    workerId: "worker-1",
    now: "2026-08-07T00:00:01.000Z",
    limit: 10,
    leaseSeconds: 30,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(claimed[0]?.id, outbox.id);
  assert.throws(
    () => markWorkflowOutboxPublishedSync(outbox.id, "worker-2", WORKSPACE_ID),
    /workflow_outbox_lease_conflict/,
  );
  markWorkflowOutboxPublishedSync(outbox.id, "worker-1", WORKSPACE_ID);
});
