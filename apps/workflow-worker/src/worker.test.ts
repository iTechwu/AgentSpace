import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowWorkerTick, type WorkflowWorkerServices } from "./worker.ts";

test("worker tick runs scheduler, outbox and recovery with bounded batches", async () => {
  const calls: string[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: ({ limit }) => { calls.push(`scheduler:${limit}`); return { createdRunIds: ["run-1"] }; },
    outbox: ({ limit }) => { calls.push(`outbox:${limit}`); return { dispatchedTaskIds: ["task-1"] }; },
    recovery: ({ limit }) => { calls.push(`recovery:${limit}`); return { readyNodeRunIds: ["node-1"], retriedNodeRunIds: [], failedNodeRunIds: [] }; },
  };

  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "2026-08-07T00:00:00.000Z", services });

  assert.deepEqual(calls, ["scheduler:20", "outbox:20", "recovery:20"]);
  assert.deepEqual(result, { scheduled: 1, dispatched: 1, recovered: 1 });
});

test("worker tick caps batch size", async () => {
  const limits: number[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: ({ limit }) => { limits.push(limit); return { createdRunIds: [] }; },
    outbox: ({ limit }) => { limits.push(limit); return { dispatchedTaskIds: [] }; },
    recovery: ({ limit }) => { limits.push(limit); return { readyNodeRunIds: [], retriedNodeRunIds: [], failedNodeRunIds: [] }; },
  };
  await runWorkflowWorkerTick({ workerId: "w1", batchSize: 1000, services });
  assert.deepEqual(limits, [100, 100, 100]);
});
