import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowWorkerTick, type WorkflowWorkerServices } from "./worker.ts";

test("worker tick runs scheduler, outbox and recovery with bounded batches", async () => {
  const calls: string[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: ({ limit }) => { calls.push(`scheduler:${limit}`); return { createdRunIds: ["run-1"], failedTriggerIds: ["trigger-1"] }; },
    outbox: ({ limit }) => { calls.push(`outbox:${limit}`); return { dispatchedTaskIds: ["task-1"] }; },
    recovery: ({ limit }) => { calls.push(`recovery:${limit}`); return { readyNodeRunIds: ["node-1"], retriedNodeRunIds: [], failedNodeRunIds: [] }; },
  };

  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "2026-08-07T00:00:00.000Z", services });

  assert.deepEqual(calls, ["scheduler:20", "outbox:20", "recovery:20"]);
  assert.deepEqual(result, { scheduled: 1, schedulerFailures: 1, dispatched: 1, recovered: 1 });
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

test("worker tick counts approval expiry failures and scan failures in schedulerFailures", async () => {
  // schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败
  // 与整轮扫描失败都计入，确保监控不会把审批失败报告为 0。
  const services: WorkflowWorkerServices = {
    scheduler: () => ({ createdRunIds: [], failedTriggerIds: ["t-1"], expiredApprovalFailures: [{}, {}], approvalScanFailed: true }),
    outbox: () => ({ dispatchedTaskIds: [] }),
    recovery: () => ({ readyNodeRunIds: [], retriedNodeRunIds: [], failedNodeRunIds: [] }),
  };
  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "2026-08-07T00:00:00.000Z", services });
  // 1 触发器失败 + 2 审批限时失败 + 1 整轮扫描失败 = 4。
  assert.equal(result.schedulerFailures, 4);
});
