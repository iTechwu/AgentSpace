import assert from "node:assert/strict";
import test from "node:test";
import { maybeFlushWorkflowWorkerSloSync, runWorkflowWorkerTick, type WorkflowWorkerSloFlushState, type WorkflowWorkerServices } from "./worker.ts";
import type { WorkflowApprovalExpiryFailure, WorkflowOutboxDispatchResult, WorkflowRecoveryResult, WorkflowSchedulerTickResult } from "@dofe-agent/services/workflows";

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

// 构造完整 WorkflowOutboxDispatchResult / WorkflowRecoveryResult，与服务层契约逐字段对齐——
// 服务层新增字段时编译器在此强制补齐，避免 Worker 边界再次漂移（如 requeuedReadyNodeRunIds）。
function outboxResult(overrides: Partial<WorkflowOutboxDispatchResult> = {}): WorkflowOutboxDispatchResult {
  return {
    claimedOutboxIds: [],
    publishedOutboxIds: [],
    dispatchedTaskIds: [],
    failedOutboxIds: [],
    leaseConflictOutboxIds: [],
    ...overrides,
  };
}

function recoveryResult(overrides: Partial<WorkflowRecoveryResult> = {}): WorkflowRecoveryResult {
  return {
    readyNodeRunIds: [],
    retriedNodeRunIds: [],
    failedNodeRunIds: [],
    orphanedTaskIds: [],
    requeuedReadyNodeRunIds: [],
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

test("worker tick counts requeued ready nodes in recovered (recovery contract propagation)", async () => {
  // 覆盖矩阵 Worker 闭环：服务层 recovery 结果的 requeuedReadyNodeRunIds 必须完整传播到 Worker 的
  // recovered 计数。旧实现 Worker 接口未声明该字段，访问 undefined.length 崩溃；此用例锁定传播。
  const services: WorkflowWorkerServices = {
    scheduler: () => tickResult(),
    outbox: () => outboxResult(),
    recovery: () => recoveryResult({ readyNodeRunIds: ["n-1"], requeuedReadyNodeRunIds: ["n-2", "n-3"] }),
  };
  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "2026-08-07T00:00:00.000Z", services });
  assert.equal(result.recovered, 3);
});

test("worker tick runs scheduler, outbox and recovery with bounded batches", async () => {
  const calls: string[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: ({ limit }) => { calls.push(`scheduler:${limit}`); return tickResult({ createdRunIds: ["run-1"], failedTriggerIds: ["trigger-1"] }); },
    outbox: ({ limit }) => { calls.push(`outbox:${limit}`); return outboxResult({ dispatchedTaskIds: ["task-1"] }); },
    recovery: ({ limit }) => { calls.push(`recovery:${limit}`); return recoveryResult({ readyNodeRunIds: ["node-1"] }); },
  };

  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "2026-08-07T00:00:00.000Z", services });

  assert.deepEqual(calls, ["scheduler:20", "outbox:20", "recovery:20"]);
  assert.deepEqual(result, { scheduled: 1, schedulerFailures: 1, dispatched: 1, recovered: 1 });
});

test("worker tick caps batch size", async () => {
  const limits: number[] = [];
  const services: WorkflowWorkerServices = {
    scheduler: ({ limit }) => { limits.push(limit); return tickResult(); },
    outbox: ({ limit }) => { limits.push(limit); return outboxResult(); },
    recovery: ({ limit }) => { limits.push(limit); return recoveryResult(); },
  };
  await runWorkflowWorkerTick({ workerId: "w1", batchSize: 1000, services });
  assert.deepEqual(limits, [100, 100, 100]);
});

test("worker tick counts approval expiry failures and scan failures in schedulerFailures", async () => {
  // schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败
  // 与整轮扫描失败都计入，确保监控不会把审批失败报告为 0。
  const services: WorkflowWorkerServices = {
    scheduler: () => tickResult({ failedTriggerIds: ["t-1"], expiredApprovalFailures: [approvalFailure(), approvalFailure({ approvalId: "approval-2" })], approvalScanFailure: { errorCode: "workflow_approval_scan_failed", occurredAt: "2026-08-07T00:00:00.000Z" } }),
    outbox: () => outboxResult(),
    recovery: () => recoveryResult(),
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
    outbox: () => { calls.push("outbox"); return outboxResult(); },
    recovery: () => { calls.push("recovery"); return recoveryResult(); },
  };
  const result = await runWorkflowWorkerTick({ workerId: "w1", batchSize: 20, now: "not-a-valid-date", services });
  assert.deepEqual(calls, ["scheduler"]);
  assert.deepEqual(result, { scheduled: 0, schedulerFailures: 1, dispatched: 0, recovered: 0 });
});

test("worker SLO flush throttles by interval and threads windowStart from last success", () => {
  // worker 进程的 SLO 窗口必须由 worker 自己落账（Web/maintenance cron 刷不到本进程样本）；
  // 节流窗口内重复调用不落账，跨窗口调用以 lastFlushAtMs（上次成功）作为 windowStart。
  const flushes: Array<{ instanceId: string; windowStart?: string; now: string }> = [];
  const flush = (input: { instanceId: string; windowStart?: string; now: string }): number => {
    flushes.push(input);
    return 1;
  };
  const state: WorkflowWorkerSloFlushState = {};

  const first = maybeFlushWorkflowWorkerSloSync({ workerId: "w1", state, nowMs: 1_000_000, flushIntervalMs: 60_000, flush });
  const throttled = maybeFlushWorkflowWorkerSloSync({ workerId: "w1", state, nowMs: 1_030_000, flushIntervalMs: 60_000, flush });
  const second = maybeFlushWorkflowWorkerSloSync({ workerId: "w1", state, nowMs: 1_070_000, flushIntervalMs: 60_000, flush });

  assert.equal(first, 1);
  assert.equal(throttled, 0);
  assert.equal(second, 1);
  assert.equal(flushes.length, 2);
  assert.equal(flushes[0]?.windowStart, undefined);
  assert.equal(flushes[0]?.instanceId, "workflow-worker-w1");
  assert.equal(flushes[1]?.windowStart, new Date(1_000_000).toISOString());
  assert.equal(flushes[1]?.now, new Date(1_070_000).toISOString());
});

test("worker SLO flush failure retries next interval without advancing the success window", () => {
  // 失败不推进 lastFlushAtMs（windowStart 仍为空，失败域样本留给下次整段覆盖），
  // 但推进 lastAttemptAtMs：节流窗口内不重试，跨窗口后重试一次。
  const state: WorkflowWorkerSloFlushState = {};
  let attempts = 0;
  const flush = (): number => {
    attempts += 1;
    if (attempts === 1) throw new Error("ledger unavailable");
    return 2;
  };
  assert.throws(() => maybeFlushWorkflowWorkerSloSync({ workerId: "w1", state, nowMs: 1_000_000, flushIntervalMs: 60_000, flush }));
  maybeFlushWorkflowWorkerSloSync({ workerId: "w1", state, nowMs: 1_010_000, flushIntervalMs: 60_000, flush });
  assert.equal(attempts, 1);
  // 跨过失败尝试一个周期后重试成功；此前从未成功过，windowStart 保持 undefined。
  const flushed = maybeFlushWorkflowWorkerSloSync({ workerId: "w1", state, nowMs: 1_070_000, flushIntervalMs: 60_000, flush });
  assert.equal(flushed, 2);
  assert.equal(attempts, 2);
  // 成功之后，下一次 flush 的 windowStart 指向该成功时刻。
  const flushes: Array<{ windowStart?: string }> = [];
  maybeFlushWorkflowWorkerSloSync({
    workerId: "w1", state, nowMs: 1_140_000, flushIntervalMs: 60_000,
    flush: (input) => { flushes.push(input); return 0; },
  });
  assert.equal(flushes[0]?.windowStart, new Date(1_070_000).toISOString());
});
