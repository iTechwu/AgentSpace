import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWorkflowNodeFromOutboxPrisma } from "./workflow-dispatch-prisma-write.ts";

test("dispatcher Prisma writer keeps claim, queue, events and outbox acknowledgement in one transaction", async () => {
  const calls: string[] = [];
  const tx = {
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
      upsert: async () => { calls.push("queue.upsert"); return { id: "queue-workflow-node-run-1" }; },
    },
    agentRouterEvent: { create: async () => { calls.push("router.event"); } },
    taskExecutionEvent: { create: async () => { calls.push("task.event"); } },
    workflowRun: {
      update: async () => ({ workspaceId: "workspace-1", currentSequence: 1 }),
    },
    workflowRunEvent: { create: async () => { calls.push("workflow.event"); } },
    workflowOutbox: { updateMany: async () => { calls.push("outbox.publish"); return { count: 1 }; } },
  };
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const result = await dispatchWorkflowNodeFromOutboxPrisma({
    workspaceId: "workspace-1",
    nodeRunId: "node-run-1",
    employeeId: "employee-1",
    title: "Publish report",
    inputJson: { report: "draft" },
    workflowMetadata: { workflowRunId: "run-1" },
    maxConcurrency: 4,
    now: "2026-08-17T00:00:00.000Z",
    outbox: { id: "outbox-1", workerId: "worker-1" },
  }, client as never);

  assert.deepEqual(result, {
    nodeRunId: "node-run-1",
    status: "queued",
    taskQueueId: "queue-workflow-node-run-1",
    reason: "claimed",
  });
  assert.deepEqual(calls, ["outbox.publish", "node.update", "queue.upsert", "node.update", "router.event", "task.event", "workflow.event", "outbox.publish"]);
});
