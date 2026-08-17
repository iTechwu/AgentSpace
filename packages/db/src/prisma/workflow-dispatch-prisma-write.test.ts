import assert from "node:assert/strict";
import test from "node:test";
import { observeLegacyTaskEnqueueEventOrder } from "../task-enqueue-event-contract.ts";
import { dispatchWorkflowNodeFromOutboxPrisma } from "./workflow-dispatch-prisma-write.ts";

const input = {
  workspaceId: "workspace-1",
  runId: "run-1",
  nodeRunId: "node-run-1",
  employeeId: "employee-1",
  title: "Publish report",
  inputJson: { report: "draft" },
  workflowMetadata: { workflowRunId: "run-1" },
  maxConcurrency: 4,
  now: "2026-08-17T00:00:00.000Z",
  outbox: { id: "outbox-1", workerId: "worker-1" },
};

test("dispatcher Prisma writer keeps claim, queue, events and outbox acknowledgement in one transaction", async () => {
  const calls: string[] = [];
  let persistedRouterEventType = "task_queued";
  const tx = {
    $queryRaw: async () => [{ id: "run-1", status: "running" }],
    workflowNodeRun: {
      findFirst: async () => ({ id: "node-run-1", runId: "run-1", status: "ready", taskQueueId: null, nodeId: "node-1", employeeId: "employee-1", attemptCount: 0 }),
      count: async () => 0,
      updateMany: async () => { calls.push("node.update"); return { count: 1 }; },
    },
    workspaceEmployee: {
      findFirst: async () => ({ id: "employee-1", name: "Writer" }),
    },
    employeeRuntimeBinding: {
      findUnique: async () => ({ employeeId: "employee-1", employeeName: "Writer", runtimeId: "runtime-1", status: "online", runtime: { id: "runtime-1", name: "Runtime", provider: "openai" } }),
    },
    agentRouterSession: {
      findFirst: async () => null,
      create: async () => ({ id: "session-1" }),
      update: async () => ({ id: "session-1" }),
    },
    agentTaskQueue: {
      findUnique: async () => null,
      create: async () => { calls.push("queue.create"); return { id: "queue-workflow-node-run-1" }; },
    },
    agentRouterEvent: { create: async () => { calls.push("router.event"); return { type: persistedRouterEventType }; } },
    taskExecutionEvent: { create: async () => { calls.push("task.event"); return { type: "queued" }; } },
    workflowRun: {
      update: async () => ({ workspaceId: "workspace-1", currentSequence: 1 }),
    },
    workflowRunEvent: { create: async () => { calls.push("workflow.event"); } },
    workflowOutbox: { updateMany: async () => { calls.push("outbox.publish"); return { count: 1 }; } },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const result = await dispatchWorkflowNodeFromOutboxPrisma(input, client as never);

  assert.deepEqual(result, {
    nodeRunId: "node-run-1",
    status: "queued",
    taskQueueId: "queue-workflow-node-run-1",
    reason: "claimed",
    observability: { eventOrder: { comparedCount: 1, driftCount: 0 } },
  });
  assert.deepEqual(calls, ["outbox.publish", "node.update", "queue.create", "node.update", "router.event", "task.event", "workflow.event", "outbox.publish"]);

  persistedRouterEventType = "unexpected";
  const drifted = await dispatchWorkflowNodeFromOutboxPrisma(input, client as never);
  assert.deepEqual(drifted.observability?.eventOrder, { comparedCount: 1, driftCount: 1 });
});

test("dispatcher event-order observer detects a sequence that differs from legacy", () => {
  assert.deepEqual(observeLegacyTaskEnqueueEventOrder([
    { stream: "queue", type: "queued" },
    { stream: "router", type: "task_queued" },
  ]), { comparedCount: 1, driftCount: 1 });
});

test("dispatcher Prisma writer retries a serializable conflict", async () => {
  let transactionAttempts = 0;
  const tx = {
    $queryRaw: async () => [{ id: "run-1", status: "running" }],
    workflowNodeRun: {
      findFirst: async () => ({ id: "node-run-1", runId: "run-1", status: "queued", taskQueueId: "queue-workflow-node-run-1" }),
    },
    workflowOutbox: { updateMany: async () => ({ count: 1 }) },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      transactionAttempts += 1;
      if (transactionAttempts === 1) throw Object.assign(new Error("serialization failure"), { code: "P2034" });
      return callback(tx);
    },
  };

  const result = await dispatchWorkflowNodeFromOutboxPrisma(input, client as never);
  assert.equal(transactionAttempts, 2);
  assert.equal(result.reason, "already_queued");
});

test("dispatcher Prisma writer defers an unavailable employee queue and acknowledges the outbox", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [{ id: "run-1", status: "running" }],
    workflowNodeRun: {
      findFirst: async () => ({ id: "node-run-1", runId: "run-1", status: "ready", taskQueueId: null }),
      count: async () => 0,
      updateMany: async (args: Record<string, unknown>) => { updates.push(args); return { count: 1 }; },
    },
    workspaceEmployee: { findFirst: async () => null },
    workflowRun: { update: async () => ({ workspaceId: "workspace-1", currentSequence: 1 }) },
    workflowRunEvent: { create: async () => undefined },
    workflowOutbox: { updateMany: async () => ({ count: 1 }) },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };

  const result = await dispatchWorkflowNodeFromOutboxPrisma(input, client as never);
  assert.deepEqual(result, { nodeRunId: "node-run-1", status: "retry_wait", reason: "queue_unavailable" });
  assert.equal(((updates[1]?.data as Record<string, unknown>).errorCode), "workflow_task_queue_unavailable");
  assert.equal(((updates[1]?.data as Record<string, unknown>).status), "retry_wait");
});

test("dispatcher Prisma writer does not duplicate lifecycle events for an existing queue task", async () => {
  let routerEvents = 0;
  let taskEvents = 0;
  const tx = {
    $queryRaw: async () => [{ id: "run-1", status: "running" }],
    workflowNodeRun: {
      findFirst: async () => ({ id: "node-run-1", runId: "run-1", status: "ready", taskQueueId: null, nodeId: "node-1", employeeId: "employee-1", attemptCount: 0 }),
      count: async () => 0,
      updateMany: async () => ({ count: 1 }),
    },
    workspaceEmployee: { findFirst: async () => ({ id: "employee-1", name: "Writer" }) },
    employeeRuntimeBinding: {
      findUnique: async () => ({ employeeId: "employee-1", employeeName: "Writer", runtimeId: "runtime-1", status: "online", runtime: { id: "runtime-1", name: "Runtime", provider: "openai" } }),
    },
    agentRouterSession: { findFirst: async () => ({ id: "session-1" }), update: async () => ({ id: "session-1" }) },
    agentTaskQueue: { findUnique: async () => ({ id: "queue-workflow-node-run-1" }) },
    agentRouterEvent: { create: async () => { routerEvents += 1; return { type: "task_queued" }; } },
    taskExecutionEvent: { create: async () => { taskEvents += 1; return { type: "queued" }; } },
    workflowRun: { update: async () => ({ workspaceId: "workspace-1", currentSequence: 1 }) },
    workflowRunEvent: { create: async () => undefined },
    workflowOutbox: { updateMany: async () => ({ count: 1 }) },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };

  const result = await dispatchWorkflowNodeFromOutboxPrisma(input, client as never);
  assert.equal(result.reason, "claimed");
  assert.equal(routerEvents, 0);
  assert.equal(taskEvents, 0);
});
