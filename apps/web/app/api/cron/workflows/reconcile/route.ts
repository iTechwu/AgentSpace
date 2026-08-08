import {
  dispatchWorkflowOutboxBatchSync,
  recoverStaleWorkflowWorkSync,
  tickWorkflowSchedulerSync,
} from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.slice("Bearer ".length).trim() !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const workerId = `cron:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const limit = 20;
  const scheduled = tickWorkflowSchedulerSync({ workerId, now, limit });
  // 非法时钟：outbox/recovery 同样依赖 now，强行推进只会再次抛错。提前返回，确保
  // schedulerFailures（含 invalidClock）可观测、整轮不被非结构化异常中断。
  if (scheduled.invalidClock) {
    return Response.json({ scheduled: 0, schedulerFailures: 1, dispatched: 0, recovered: 0 });
  }
  const dispatched = dispatchWorkflowOutboxBatchSync({ workerId, now, limit });
  const recovered = recoverStaleWorkflowWorkSync({ workerId, now, limit });
  return Response.json({
    scheduled: scheduled.createdRunIds.length,
    // schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败
    // 与整轮扫描失败都计入，确保监控不会把审批失败报告为 0。
    schedulerFailures: scheduled.failedTriggerIds.length
      + scheduled.expiredApprovalFailures.length
      + (scheduled.approvalScanFailure ? 1 : 0),
    dispatched: dispatched.dispatchedTaskIds.length,
    recovered: recovered.readyNodeRunIds.length + recovered.retriedNodeRunIds.length +
      recovered.failedNodeRunIds.length + recovered.orphanedTaskIds.length +
      recovered.requeuedReadyNodeRunIds.length,
  });
}
