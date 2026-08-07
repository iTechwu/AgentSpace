import {
  dispatchWorkflowOutboxBatchSync,
  recoverStaleWorkflowWorkSync,
  tickWorkflowSchedulerSync,
  type WorkflowSchedulerTickResult,
} from "@dofe-agent/services";

export interface WorkflowWorkerServices {
  // 直接复用服务层 WorkflowSchedulerTickResult 契约，避免在 Worker 边界把它弱化为可选
  // unknown[]——服务层新增字段时编译器可强制传递，结构化失败内容也保留类型约束。
  scheduler(input: { now: string; workerId: string; limit: number }): WorkflowSchedulerTickResult;
  outbox(input: { now: string; workerId: string; limit: number }): { dispatchedTaskIds: string[] };
  recovery(input: { now: string; workerId: string; limit: number }): { readyNodeRunIds: string[]; retriedNodeRunIds: string[]; failedNodeRunIds: string[] };
}

export const defaultWorkflowWorkerServices: WorkflowWorkerServices = {
  scheduler: tickWorkflowSchedulerSync,
  outbox: dispatchWorkflowOutboxBatchSync,
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
    recovered: recovered.readyNodeRunIds.length + recovered.retriedNodeRunIds.length + recovered.failedNodeRunIds.length,
  };
}

// schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败、
// 整轮扫描失败与入口非法时钟都计入，确保生产监控不会把调度/审批失败报告为 0。
function countSchedulerFailures(scheduled: WorkflowSchedulerTickResult): number {
  return scheduled.failedTriggerIds.length
    + scheduled.expiredApprovalFailures.length
    + (scheduled.approvalScanFailed ? 1 : 0)
    + (scheduled.invalidClock ? 1 : 0);
}
