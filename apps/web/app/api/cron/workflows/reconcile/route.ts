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
  const dispatched = dispatchWorkflowOutboxBatchSync({ workerId, now, limit });
  const recovered = recoverStaleWorkflowWorkSync({ workerId, now, limit });
  return Response.json({
    scheduled: scheduled.createdRunIds.length,
    // schedulerFailures 是告警出口（后端设计文档:119）：触发器物化失败、审批限时扫描单条失败
    // 与整轮扫描失败都计入，确保监控不会把审批失败报告为 0。
    schedulerFailures: scheduled.failedTriggerIds.length
      + scheduled.expiredApprovalFailures.length
      + (scheduled.approvalScanFailed ? 1 : 0),
    dispatched: dispatched.dispatchedTaskIds.length,
    recovered: recovered.readyNodeRunIds.length + recovered.retriedNodeRunIds.length +
      recovered.failedNodeRunIds.length + recovered.orphanedTaskIds.length,
  });
}
