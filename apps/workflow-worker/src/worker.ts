import { dispatchWorkflowOutboxBatchAuto, flushWorkflowWorkerPrismaCutoverSloSync, recoverStaleWorkflowWorkSync, tickWorkflowSchedulerAuto, type WorkflowOutboxDispatchResult, type WorkflowRecoveryResult, type WorkflowSchedulerTickResult } from "@dofe-agent/services/workflows";

export interface WorkflowWorkerServices {
  // 直接复用服务层结果契约（scheduler/outbox/recovery），避免在 Worker 边界把它们弱化为
  // 自声明子集——服务层新增字段（如 recovery 的 requeuedReadyNodeRunIds）时编译器可强制传播，
  // 否则 Worker 读取未声明字段会 TS2339 并在运行时崩溃（recovered.length 访问 undefined）。
  scheduler(input: { now: string; workerId: string; limit: number }): WorkflowSchedulerTickResult | Promise<WorkflowSchedulerTickResult>;
  outbox(input: { now: string; workerId: string; limit: number }): WorkflowOutboxDispatchResult | Promise<WorkflowOutboxDispatchResult>;
  recovery(input: { now: string; workerId: string; limit: number }): WorkflowRecoveryResult;
}

export const defaultWorkflowWorkerServices: WorkflowWorkerServices = {
  scheduler: tickWorkflowSchedulerAuto,
  outbox: dispatchWorkflowOutboxBatchAuto,
  recovery: recoverStaleWorkflowWorkSync,
};

export async function runWorkflowWorkerTick(input: {
  workerId: string;
  batchSize: number;
  now?: string;
  services?: WorkflowWorkerServices;
}): Promise<{ scheduled: number; schedulerFailures: number; dispatched: number; recovered: number }> {
  const services = input.services ?? defaultWorkflowWorkerServices;
  const limit = Math.max(1, Math.min(input.batchSize, 100));
  const now = input.now ?? new Date().toISOString();
  const scheduled = await services.scheduler({ now, workerId: input.workerId, limit });
  // 非法时钟（invalidClock）：outbox/recovery 同样依赖 now（如 outbox 的延迟计算 toISOString），
  // 强行推进只会再抛一次。提前返回结构化结果，确保 schedulerFailures 可观测、整轮不被中断。
  if (scheduled.invalidClock) {
    return {
      scheduled: 0,
      schedulerFailures: countSchedulerFailures(scheduled),
      dispatched: 0,
      recovered: 0,
    };
  }
  const dispatched = await services.outbox({ now, workerId: input.workerId, limit });
  const recovered = await services.recovery({ now, workerId: input.workerId, limit });
  return {
    scheduled: scheduled.createdRunIds.length,
    schedulerFailures: countSchedulerFailures(scheduled),
    dispatched: dispatched.dispatchedTaskIds.length,
    recovered: recovered.readyNodeRunIds.length + recovered.retriedNodeRunIds.length + recovered.failedNodeRunIds.length + recovered.requeuedReadyNodeRunIds.length,
  };
}

export interface WorkflowWorkerSloFlushState {
  /** 上次 flush 的 epoch 毫秒；undefined 表示本进程尚未 flush 过。 */
  lastFlushAtMs?: number;
}

const DEFAULT_SLO_FLUSH_INTERVAL_MS = 60_000;

/**
 * worker 进程内 SLO 窗口节流落账：指标样本累积在本进程 sharedSloWindow，
 * Web/maintenance cron 的 flush 刷不到 worker 进程；由 worker 循环按
 * flushIntervalMs 调用本函数，把窗口写入集中 audit ledger。
 * windowStart 取上次 flush 时刻，保证单窗口跨度不超过 flush 周期。
 */
export function maybeFlushWorkflowWorkerSloSync(input: {
  workerId: string;
  state: WorkflowWorkerSloFlushState;
  nowMs: number;
  flushIntervalMs?: number;
  flush?: (flushInput: { instanceId: string; windowStart?: string; now: string }) => number;
}): number {
  const intervalMs = Math.min(
    Math.max(Math.trunc(input.flushIntervalMs ?? DEFAULT_SLO_FLUSH_INTERVAL_MS), 5_000),
    3_600_000,
  );
  const lastFlushAtMs = input.state.lastFlushAtMs;
  if (lastFlushAtMs !== undefined && input.nowMs - lastFlushAtMs < intervalMs) return 0;
  const windowStart = lastFlushAtMs !== undefined ? new Date(lastFlushAtMs).toISOString() : undefined;
  const now = new Date(input.nowMs).toISOString();
  input.state.lastFlushAtMs = input.nowMs;
  const flush = input.flush ?? flushWorkflowWorkerPrismaCutoverSloSync;
  return flush({ instanceId: `workflow-worker-${input.workerId}`, windowStart, now });
}

// schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败、
// 整轮扫描失败与入口非法时钟都计入，确保生产监控不会把调度/审批失败报告为 0。
function countSchedulerFailures(scheduled: WorkflowSchedulerTickResult): number {
  return scheduled.failedTriggerIds.length
    + scheduled.expiredApprovalFailures.length
    + (scheduled.approvalScanFailure ? 1 : 0)
    + (scheduled.invalidClock ? 1 : 0);
}
