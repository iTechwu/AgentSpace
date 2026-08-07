import {
  dispatchWorkflowOutboxBatchSync,
  recoverStaleWorkflowWorkSync,
  tickWorkflowSchedulerSync,
} from "@dofe-agent/services";

export interface WorkflowWorkerServices {
  scheduler(input: { now: string; workerId: string; limit: number }): { createdRunIds: string[]; failedTriggerIds?: string[] };
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
  const dispatched = await services.outbox({ now, workerId: input.workerId, limit });
  const recovered = await services.recovery({ now, workerId: input.workerId, limit });
  return {
    scheduled: scheduled.createdRunIds.length,
    schedulerFailures: scheduled.failedTriggerIds?.length ?? 0,
    dispatched: dispatched.dispatchedTaskIds.length,
    recovered: recovered.readyNodeRunIds.length + recovered.retriedNodeRunIds.length + recovered.failedNodeRunIds.length,
  };
}
