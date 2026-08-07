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
    schedulerFailures: scheduled.failedTriggerIds.length,
    dispatched: dispatched.dispatchedTaskIds.length,
    recovered: recovered.readyNodeRunIds.length + recovered.retriedNodeRunIds.length +
      recovered.failedNodeRunIds.length + recovered.orphanedTaskIds.length,
  });
}
