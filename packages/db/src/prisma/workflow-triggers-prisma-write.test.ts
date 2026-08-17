import assert from "node:assert/strict";
import test from "node:test";
import { advanceWorkflowTriggerPrisma, claimDueWorkflowTriggersPrisma } from "./workflow-triggers-prisma.ts";

const trigger = {
  id: "trigger-1",
  workspaceId: "workspace-1",
  workflowId: "workflow-1",
  type: "schedule",
  configJson: {},
  timezone: null,
  status: "active",
  nextFireAt: new Date("2026-08-17T00:00:00.000Z"),
  lastFireAt: null,
  misfirePolicy: "skip",
  dedupeWindowSeconds: 0,
  leaseOwner: "worker-1",
  leaseExpiresAt: new Date("2026-08-17T00:01:00.000Z"),
  createdAt: new Date("2026-08-16T00:00:00.000Z"),
  updatedAt: new Date("2026-08-17T00:00:00.000Z"),
};

test("Prisma trigger claim checks published workflow and CAS lease", async () => {
  let updateCount = 0;
  const tx = {
    workflowTrigger: {
      findMany: async () => [trigger],
      updateMany: async () => {
        updateCount += 1;
        return { count: 1 };
      },
      findUnique: async () => trigger,
    },
    workflowDefinition: {
      findFirst: async () => ({ id: "workflow-1" }),
    },
  };
  const client = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) };
  const claimed = await claimDueWorkflowTriggersPrisma({
    workerId: "worker-1",
    now: "2026-08-17T00:00:00.000Z",
    limit: 10,
    leaseSeconds: 60,
  }, client as never);
  assert.equal(updateCount, 1);
  assert.equal(claimed[0]?.leaseOwner, "worker-1");
});

test("Prisma trigger advance returns null when the lease owner changed", async () => {
  const client = {
    workflowTrigger: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => trigger,
    },
  };
  const result = await advanceWorkflowTriggerPrisma({
    id: "trigger-1",
    workspaceId: "workspace-1",
    workerId: "worker-1",
    nextFireAt: null,
    now: "2026-08-17T00:02:00.000Z",
  }, client as never);
  assert.equal(result, null);
});
