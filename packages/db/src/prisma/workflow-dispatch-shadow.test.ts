import assert from "node:assert/strict";
import test from "node:test";
import { compareWorkflowDispatchShadow, projectWorkflowDispatchShadowSnapshot, type WorkflowDispatchShadowSnapshot } from "./workflow-dispatch-shadow.ts";

function snapshot(overrides: Partial<WorkflowDispatchShadowSnapshot> = {}): WorkflowDispatchShadowSnapshot {
  return {
    result: { nodeRunId: "node-1", taskQueueId: "queue-1", status: "queued" },
    queue: { id: "queue-1", inputJson: { taskId: "node-1", priority: 0 } },
    routerSession: { id: "session-1", updatedAt: "2026-08-18T00:00:00.000Z" },
    routerEvents: [{ id: "router-event-1", routerSessionId: "session-1", type: "task_queued", dataJson: { priority: "medium" } }],
    taskEvent: { id: "task-event-1", type: "queued", dataJson: { priority: "medium" } },
    nodeRun: { id: "node-1", status: "queued", taskQueueId: "queue-1", updatedAt: new Date("2026-08-18T00:00:00.000Z") },
    ...overrides,
  };
}

test("workflow dispatch shadow compares all five durable objects and normalizes timestamps", () => {
  const actual = snapshot();
  const expected = snapshot({
    routerSession: { id: "session-1", updatedAt: new Date("2026-08-18T00:00:00.000Z") },
  });
  assert.deepEqual(compareWorkflowDispatchShadow(actual, expected), {
    comparedCount: 1,
    mismatchCount: 0,
    diffFields: [],
  });
});

test("workflow dispatch shadow reports precise object fields", () => {
  const comparison = compareWorkflowDispatchShadow(
    snapshot({ taskEvent: { id: "task-event-1", type: "assigned", dataJson: { priority: "medium" } } }),
    snapshot(),
  );
  assert.equal(comparison.comparedCount, 1);
  assert.equal(comparison.mismatchCount, 1);
  assert.deepEqual(comparison.diffFields, ["taskEvent.type"]);
});

test("workflow dispatch shadow canonicalizes generated ids but still detects broken relationships", () => {
  const actual = snapshot({
    routerSession: { id: "prisma-session", updatedAt: "2026-08-18T00:00:00.000Z" },
    queue: { id: "queue-1", routerSessionId: "prisma-session", inputJson: { taskId: "node-1", priority: 0 } },
    routerEvents: [{ id: "prisma-event", routerSessionId: "prisma-session", type: "task_queued", dataJson: {} }],
  });
  const legacy = snapshot({
    routerSession: { id: "legacy-session", updatedAt: "2026-08-18T00:00:00.000Z" },
    queue: { id: "queue-1", routerSessionId: "legacy-session", inputJson: { taskId: "node-1", priority: 0 } },
    routerEvents: [{ id: "legacy-event", routerSessionId: "legacy-session", type: "task_queued", dataJson: {} }],
  });
  assert.equal(compareWorkflowDispatchShadow(actual, legacy).mismatchCount, 0);

  const broken = snapshot({ ...actual, queue: { ...actual.queue, routerSessionId: "wrong-session" } });
  assert.deepEqual(compareWorkflowDispatchShadow(broken, legacy).diffFields, ["queue.routerSessionId"]);
});

test("workflow dispatch shadow projects legacy JSON columns and projected router event references", () => {
  const base = {
    result: { nodeRunId: "node-1", taskQueueId: "queue-1", status: "queued" },
    queue: { id: "queue-1", workspaceId: "workspace-1", inputJson: JSON.stringify({ taskId: "node-1" }), routerSessionId: "session-a" },
    routerSession: { id: "session-a", workspaceId: "workspace-1", agentId: "employee-1", updatedAt: "2026-08-18T00:00:00.000Z" },
    routerEvents: [
      { id: "router-a", routerSessionId: "session-a", type: "task_queued", dataJson: JSON.stringify({ priority: "medium" }) },
      { id: "router-b", routerSessionId: "session-a", type: "task.queued", dataJson: JSON.stringify({ taskExecutionEventId: "task-a", title: "Task", severity: "info" }) },
    ],
    taskEvent: { id: "task-a", taskId: "queue-1", type: "queued", dataJson: JSON.stringify({ priority: "medium" }) },
    nodeRun: { id: "node-1", inputJson: JSON.stringify({ input: true }), status: "queued" },
  };
  const prisma = projectWorkflowDispatchShadowSnapshot(base);
  const legacy = projectWorkflowDispatchShadowSnapshot({
    ...base,
    queue: { ...base.queue, routerSessionId: "session-b" },
    routerSession: { ...base.routerSession, id: "session-b" },
    routerEvents: base.routerEvents.map((event, index) => ({ ...event, id: `legacy-router-${index}`, routerSessionId: "session-b", dataJson: index === 1 ? JSON.stringify({ taskExecutionEventId: "legacy-task", title: "Task", severity: "info" }) : event.dataJson })),
    taskEvent: { ...base.taskEvent, id: "legacy-task" },
  });
  assert.deepEqual(compareWorkflowDispatchShadow(prisma, legacy), {
    comparedCount: 1,
    mismatchCount: 0,
    diffFields: [],
  });
});
