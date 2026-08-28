import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskQueueId } from "../task-queue.ts";
import { observeLegacyTaskEnqueueEventOrder } from "../task-enqueue-event-contract.ts";
import { dispatchWorkflowNodeFromOutboxPrisma, previewWorkflowNodeDispatchPrisma } from "./workflow-dispatch-prisma-write.ts";

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
  assert.deepEqual(calls, ["outbox.publish", "node.update", "queue.create", "node.update", "router.event", "task.event", "router.event", "workflow.event", "outbox.publish"]);

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

test("dispatcher Prisma preview captures the result and all five durable objects before rollback", async () => {
  const queueId = buildTaskQueueId(input.workspaceId, `workflow-node:${input.nodeRunId}`);
  let queue: Record<string, unknown> | null = null;
  let session: Record<string, unknown> | null = null;
  const routerEvents: Array<Record<string, unknown>> = [];
  let taskEvent: Record<string, unknown> | null = null;
  const tx = {
    $queryRaw: async () => [{ id: input.runId, status: "running" }],
    workflowNodeRun: {
      findFirst: async () => ({
        id: input.nodeRunId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        nodeId: "node-1",
        nodeType: "employee_task",
        employeeId: input.employeeId,
        status: "ready",
        attemptCount: 0,
        inputJson: {},
        taskQueueId: null,
      }),
      findUnique: async () => ({
        id: input.nodeRunId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        status: "queued",
        taskQueueId: queueId,
        inputJson: {},
        attemptCount: 0,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(input.now),
      }),
      count: async () => 0,
      updateMany: async () => ({ count: 1 }),
    },
    workspaceEmployee: { findFirst: async () => ({ id: input.employeeId, name: "Writer" }) },
    employeeRuntimeBinding: {
      findUnique: async () => ({
        employeeId: input.employeeId,
        employeeName: "Writer",
        runtimeId: "runtime-1",
        status: "online",
        runtime: { id: "runtime-1", name: "Runtime", provider: "openai" },
      }),
    },
    agentRouterSession: {
      findFirst: async () => null,
      findUnique: async () => session,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        session = { ...data, closedAt: null };
        return session;
      },
      update: async () => { throw new Error("unexpected session update"); },
    },
    agentTaskQueue: {
      findUnique: async () => queue,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        queue = data;
        return data;
      },
    },
    agentRouterEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        routerEvents.push(data);
        return data;
      },
      findMany: async () => routerEvents,
    },
    taskExecutionEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        taskEvent = data;
        return data;
      },
      findFirst: async () => taskEvent,
    },
    workflowRun: { update: async () => ({ workspaceId: input.workspaceId, currentSequence: 1 }) },
    workflowRunEvent: { create: async () => undefined },
    workflowOutbox: { updateMany: async () => ({ count: 1 }) },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };

  const preview = await previewWorkflowNodeDispatchPrisma({ ...input, outbox: undefined }, client as never);
  assert.equal(preview.result.taskQueueId, queueId);
  assert.equal(preview.snapshot.queue?.id, queueId);
  assert.match(String(preview.snapshot.routerSession?.id), /^router-session-/);
  assert.equal(preview.snapshot.queue?.routerSessionId, preview.snapshot.routerSession?.id);
  assert.deepEqual(preview.snapshot.routerEvents.map((event) => event.type), ["task_queued", "task.queued"]);
  assert.equal(preview.snapshot.taskEvent?.type, "queued");
  assert.equal(preview.snapshot.nodeRun?.status, "queued");
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
