import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getDatabase, resetDatabaseForTests } from "../database.ts";
import {
  createWorkflowDefinitionSync,
  publishWorkflowVersionSync,
  upsertWorkflowTriggerSync,
} from "./definitions.ts";
import {
  claimWorkflowNodeForDispatchSync,
  createWorkflowRunSync,
  listWorkflowRunsPageSnapshotSync,
  listWorkflowNodeRunsSync,
  materializeWorkflowNodeRunsSync,
  readWorkflowNodeRunSync,
  readWorkflowRunSync,
  resetWorkflowDescendantNodeRunsForRetrySync,
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

test("reads the first run page and total from one snapshot query", () => {
  const seed = seedVersion();
  const baseline = (getDatabase().prepare(
    "SELECT COUNT(*)::integer AS count FROM workflow_run WHERE workspace_id = ?",
  ).get(WORKSPACE_ID) as { count: number }).count;
  const created = [1, 2, 3].map((index) => createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: `workflow-runs:snapshot-${seed.workflowId}-${index}`,
    inputJson: "{}",
    now: `2099-01-0${index}T00:00:00.000Z`,
  }));

  const snapshot = listWorkflowRunsPageSnapshotSync(WORKSPACE_ID, 2);

  assert.equal(snapshot.total, baseline + 3);
  assert.deepEqual(snapshot.runs.map((run) => run.id), [created[2]!.id, created[1]!.id]);
  assert.equal("snapshotTotal" in snapshot.runs[0]!, false);
});

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

test("rejects cross-workspace run references and unsupported node types", () => {
  const seed = seedVersion();
  assert.throws(() => createWorkflowRunSync({
    workspaceId: "workflow-runs-other-workspace",
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: "workflow-runs:cross-workspace",
    inputJson: "{}",
  }), /workflow_workspace_mismatch/);

  const run = createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: "workflow-runs:unsupported-node",
    inputJson: "{}",
  });
  assert.throws(() => materializeWorkflowNodeRunsSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    nodes: [{ nodeId: "script", nodeType: "script" }],
  }), /workflow_node_type_unsupported/);
});

test("rejects a trigger owned by another workflow or with a different type", () => {
  const target = seedVersion();
  const other = seedVersion();
  const otherTrigger = upsertWorkflowTriggerSync({
    workspaceId: WORKSPACE_ID,
    workflowId: other.workflowId,
    type: "event",
    configJson: '{"eventName":"task.completed"}',
  });
  assert.throws(() => createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: target.workflowId,
    versionId: target.versionId,
    triggerId: otherTrigger.id,
    triggerType: "event",
    triggerKey: "workflow-runs:wrong-trigger-owner",
    inputJson: "{}",
  }), /workflow_workspace_mismatch/);

  const targetTrigger = upsertWorkflowTriggerSync({
    workspaceId: WORKSPACE_ID,
    workflowId: target.workflowId,
    type: "schedule",
    configJson: '{"kind":"daily"}',
  });
  assert.throws(() => createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: target.workflowId,
    versionId: target.versionId,
    triggerId: targetTrigger.id,
    triggerType: "event",
    triggerKey: "workflow-runs:wrong-trigger-type",
    inputJson: "{}",
  }), /workflow_workspace_mismatch/);
});

test("dispatch claims serialize against the run concurrency limit", () => {
  const seed = seedVersion();
  const run = createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: `workflow-runs:concurrency-${seed.workflowId}`,
    inputJson: "{}",
  });
  const nodes = materializeWorkflowNodeRunsSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    nodes: [
      { nodeId: "parallel-a", nodeType: "employee_task", employeeId: "e1" },
      { nodeId: "parallel-b", nodeType: "employee_task", employeeId: "e2" },
    ],
  });
  for (const node of nodes) {
    transitionWorkflowNodeRunSync({ workspaceId: WORKSPACE_ID, nodeRunId: node.id, from: ["pending"], to: "ready" });
  }

  const first = claimWorkflowNodeForDispatchSync({
    workspaceId: WORKSPACE_ID,
    nodeRunId: nodes[0]!.id,
    maxConcurrency: 1,
    now: "2026-08-07T00:00:00.000Z",
  });
  const second = claimWorkflowNodeForDispatchSync({
    workspaceId: WORKSPACE_ID,
    nodeRunId: nodes[1]!.id,
    maxConcurrency: 1,
    now: "2026-08-07T00:00:00.000Z",
  });

  assert.equal(first.reason, "claimed");
  assert.equal(first.nodeRun?.status, "queued");
  assert.equal(second.reason, "concurrency_limited");
  assert.equal(second.nodeRun?.status, "retry_wait");
  assert.equal(second.nodeRun?.availableAt, "2026-08-07T00:00:05.000Z");
});

test("manual retry reopens partial runs and resets only descendants", () => {
  const seed = seedVersion();
  const run = createWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    workflowId: seed.workflowId,
    versionId: seed.versionId,
    triggerType: "manual",
    triggerKey: `workflow-runs:partial-retry-${seed.workflowId}`,
    inputJson: "{}",
  });
  const nodes = materializeWorkflowNodeRunsSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    nodes: [
      { nodeId: "failed-branch", nodeType: "employee_task" },
      { nodeId: "successful-sibling", nodeType: "employee_task" },
      { nodeId: "partial-join", nodeType: "join" },
      { nodeId: "summary", nodeType: "employee_task" },
      { nodeId: "other-failed-downstream", nodeType: "employee_task" },
    ],
  });
  for (const node of nodes) {
    transitionWorkflowNodeRunSync({
      workspaceId: WORKSPACE_ID,
      nodeRunId: node.id,
      from: ["pending"],
      to: node.nodeId === "failed-branch" || node.nodeId === "other-failed-downstream" ? "failed" : "succeeded",
      allowTerminalRetry: node.nodeId === "failed-branch" || node.nodeId === "other-failed-downstream",
    });
  }
  transitionWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    from: ["created"],
    to: "partially_succeeded",
  });

  const descendants = nodes.filter((node) => (
    node.nodeId === "partial-join" || node.nodeId === "summary" || node.nodeId === "other-failed-downstream"
  ));
  resetWorkflowDescendantNodeRunsForRetrySync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    nodeIds: descendants.map((node) => node.id),
  });
  assert.ok(transitionWorkflowRunSync({
    workspaceId: WORKSPACE_ID,
    runId: run.id,
    from: ["partially_succeeded"],
    to: "running",
    allowTerminalRetry: true,
  }));

  const current = new Map(listWorkflowNodeRunsSync(WORKSPACE_ID, run.id).map((node) => [node.nodeId, node]));
  assert.equal(current.get("successful-sibling")?.status, "succeeded");
  assert.equal(current.get("partial-join")?.status, "pending");
  assert.equal(current.get("summary")?.status, "pending");
  assert.equal(current.get("summary")?.attemptCount, 2);
  assert.equal(current.get("summary")?.maxAttempts, 2);
  assert.equal(current.get("other-failed-downstream")?.status, "failed");
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
