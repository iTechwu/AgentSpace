import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowWorkerTick, type WorkflowWorkerServices } from "./worker.ts";
import type { WorkflowApprovalExpiryFailure, WorkflowSchedulerTickResult } from "@dofe-agent/services";

// 构造完整 WorkflowSchedulerTickResult，避免在 Worker 边界丢失服务层契约字段。
function tickResult(overrides: Partial<WorkflowSchedulerTickResult> = {}): WorkflowSchedulerTickResult {
  return {
    claimedTriggerIds: [],
    createdRunIds: [],
    deduplicatedTriggerIds: [],
    misfiredTriggerIds: [],
    failedTriggerIds: [],
    expiredApprovalIds: [],
    expiredApprovalFailures: [],
    approvalScanFailure: null,
    invalidClock: false,
    ...overrides,
  };
}

// 构造完整 WorkflowApprovalExpiryFailure，避免审批失败项在类型边界被弱化为空对象——
// 服务层新增必填字段（approvalId/workspaceId/errorCode）时编译器可强制传递。
function approvalFailure(overrides: Partial<WorkflowApprovalExpiryFailure> = {}): WorkflowApprovalExpiryFailure {
  return {
    approvalId: "approval-1",
    workspaceId: "ws-1",
    errorCode: "workflow_approval_scan_failed",
    ...overrides,
  };
}

test("worker tick runs scheduler, outbox and recovery with bounded batches", async () => {
  const calls: string[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: ({ limit }) => { calls.push(`scheduler:${limit}`); return tickResult({ createdRunIds: ["run-1"], failedTriggerIds: ["trigger-1"] }); },
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
    scheduler: ({ limit }) => { limits.push(limit); return tickResult(); },
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
    scheduler: () => tickResult({ failedTriggerIds: ["t-1"], expiredApprovalFailures: [approvalFailure(), approvalFailure({ approvalId: "approval-2" })], approvalScanFailure: { errorCode: "workflow_approval_scan_failed", occurredAt: "2026-08-07T00:00:00.000Z" } }),
    outbox: () => ({ dispatchedTaskIds: [] }),
    recovery: () => ({ readyNodeRunIds: [], retriedNodeRunIds: [], failedNodeRunIds: [] }),
  };
  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "2026-08-07T00:00:00.000Z", services });
  // 1 触发器失败 + 2 审批限时失败 + 1 整轮扫描失败 = 4。
  assert.equal(result.schedulerFailures, 4);
});

test("worker tick reports invalid clock in schedulerFailures and skips outbox/recovery", async () => {
  // 非法时钟：调度器返回 invalidClock，Worker 必须把其计入 schedulerFailures，并跳过
  // 同样依赖 now 的 outbox/recovery，避免再次抛错、确保整轮可观测地返回。
  const calls: string[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: () => { calls.push("scheduler"); return tickResult({ invalidClock: true }); },
    outbox: () => { calls.push("outbox"); return { dispatchedTaskIds: [] }; },
    recovery: () => { calls.push("recovery"); return { readyNodeRunIds: [], retriedNodeRunIds: [], failedNodeRunIds: [] }; },
  };
  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "not-a-valid-date", services });
  assert.deepEqual(calls, ["scheduler"]);
  assert.deepEqual(result, { scheduled: 0, schedulerFailures: 1, dispatched: 0, recovered: 0 });
});
