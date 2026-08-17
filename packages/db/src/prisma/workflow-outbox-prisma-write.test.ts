import assert from "node:assert/strict";
import test from "node:test";
import {
  claimWorkflowOutboxBatchPrisma,
  enqueueWorkflowOutboxPrisma,
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
