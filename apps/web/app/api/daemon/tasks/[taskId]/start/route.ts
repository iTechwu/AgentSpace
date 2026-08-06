import { parseTaskPayload } from "dofe-agent-daemon";
import { postMessageSync, startQueuedTaskWithWorkflowSync } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }
  if (task.status === "cancelled") {
    return Response.json({ task: { id: task.id, status: task.status }, ignored: true });
  }

  const shouldPostStartNotice = task.status !== "running";
  const started = startQueuedTaskWithWorkflowSync({ workspaceId: task.workspaceId, taskQueueId: task.id });
  const payload = parseTaskPayload(started);
  if (shouldPostStartNotice && payload.channel && !payload.contactId) {
    postMessageSync({
      channel: payload.channel,
      speaker: "系统提示",
      role: "agent",
      summary: `任务 ${payload.title || started.id} 开始执行。`,
    }, started.workspaceId);
  }
  return Response.json({
    task: {
      id: started.id,
      status: started.status,
      startedAt: started.startedAt,
      updatedAt: started.updatedAt,
    },
  });
}
