import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeInactiveWorkflowNodeOutboxPrisma,
  claimWorkflowOutboxBatchPrisma,
  enqueueWorkflowOutboxPrisma,
  markWorkflowOutboxFailedPrisma,
  markWorkflowOutboxPublishedPrisma,
} from "./workflow-outbox-prisma-write.ts";

const row = {
  id: "outbox-1",
  workspaceId: "workspace-1",
  aggregateType: "workflow_run",
  aggregateId: "run-1",
  eventType: "workflow.run.ready",
  payloadJson: { runId: "run-1" },
  status: "pending",
  attempts: 1,
  availableAt: new Date("2026-08-17T00:00:00.000Z"),
  lockedAt: new Date("2026-08-17T00:01:00.000Z"),
  lockedBy: "worker-1",
  lastError: null,
  createdAt: new Date("2026-08-17T00:00:00.000Z"),
  publishedAt: null,
};

test("Prisma outbox enqueue preserves payload and idempotent id", async () => {
  let args: Record<string, unknown> | undefined;
  const client = {
    workflowOutbox: {
      upsert: async (input: Record<string, unknown>) => {
        args = input;
        return row;
      },
    },
  };
  const result = await enqueueWorkflowOutboxPrisma({
    id: "outbox-1",
    workspaceId: "workspace-1",
    aggregateType: "workflow_run",
    aggregateId: "run-1",
    eventType: "workflow.run.ready",
    payloadJson: '{"runId":"run-1"}',
    now: "2026-08-17T00:00:00.000Z",
  }, client as never);
  assert.equal((args?.where as Record<string, unknown>).id, "outbox-1");
  assert.equal(result.payloadJson, '{"runId":"run-1"}');
});

test("Prisma outbox generates one id when caller does not provide one", async () => {
  let args: Record<string, unknown> | undefined;
  const client = {
    workflowOutbox: {
      upsert: async (input: Record<string, unknown>) => {
        args = input;
        return row;
      },
    },
  };
  await enqueueWorkflowOutboxPrisma({
    workspaceId: "workspace-1",
    aggregateType: "workflow_run",
    aggregateId: "run-1",
    eventType: "workflow.run.ready",
    payloadJson: {},
  }, client as never);
  assert.equal((args?.where as Record<string, unknown>).id, (args?.create as Record<string, unknown>).id);
});

test("Prisma outbox claim uses compare-and-swap lease updates", async () => {
  let updateCount = 0;
  const tx = {
    workflowOutbox: {
      findMany: async () => [row],
      updateMany: async () => {
        updateCount += 1;
        return { count: 1 };
      },
      findUnique: async () => row,
    },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };
  const claimed = await claimWorkflowOutboxBatchPrisma({
    workerId: "worker-1",
    now: "2026-08-17T00:00:00.000Z",
    limit: 10,
    leaseSeconds: 60,
  }, client as never);
  assert.equal(updateCount, 1);
  assert.equal(claimed[0]?.lockedBy, "worker-1");
});

test("Prisma outbox publish rejects a lost lease", async () => {
  const client = { workflowOutbox: { updateMany: async () => ({ count: 0 }) } };
  await assert.rejects(
    () => markWorkflowOutboxPublishedPrisma({ id: "outbox-1", workerId: "worker-1", workspaceId: "workspace-1" }, client as never),
    /workflow_outbox_lease_conflict/,
  );
});

test("Prisma outbox failure keeps the existing claim attempt count", async () => {
  let updateData: Record<string, unknown> | undefined;
  const tx = {
    workflowOutbox: {
      findFirst: async () => ({ attempts: 3, lockedBy: "worker-1" }),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        updateData = args.data;
        return { count: 1 };
      },
    },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };

  await markWorkflowOutboxFailedPrisma({
    id: "outbox-1",
    workerId: "worker-1",
    workspaceId: "workspace-1",
    error: "workflow_outbox_dispatch_failed",
    nextAvailableAt: "2026-08-17T00:01:00.000Z",
    maxAttempts: 8,
    now: "2026-08-17T00:00:00.000Z",
  }, client as never);

  assert.equal(updateData?.attempts, undefined);
  assert.equal(updateData?.status, "pending");
});

test("Prisma inactive-node acknowledgement locks run then node and rechecks the skip condition", async () => {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => {
      calls.push(calls.length === 0 ? "run.lock" : "node.lock");
      return calls.length === 1 ? [{ status: "paused" }] : [{ status: "ready" }];
    },
    workflowOutbox: {
      updateMany: async () => { calls.push("outbox.update"); return { count: 1 }; },
    },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };

  const acknowledged = await acknowledgeInactiveWorkflowNodeOutboxPrisma({
    id: "outbox-1",
    workerId: "worker-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    nodeRunId: "node-run-1",
    reason: "run_blocked",
    now: "2026-08-17T00:00:00.000Z",
  }, client as never);

  assert.equal(acknowledged, true);
  assert.deepEqual(calls, ["run.lock", "node.lock", "outbox.update", "outbox.update"]);
});
