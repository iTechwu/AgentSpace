import { claimNextQueuedTaskForRuntimeSync } from "@dofe-agent/db";
import { readRuntimeForDaemon, requireDaemonAuth } from "../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runtimeId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { runtimeId } = await context.params;
  const runtime = readRuntimeForDaemon(runtimeId, auth, { requireOnline: true });
  if (runtime instanceof Response) {
    return runtime;
  }

  const task = claimNextQueuedTaskForRuntimeSync(runtime.id, auth.workspaceId);
  if (!task) {
    return Response.json({ task: null });
  }

  return Response.json({
    task: {
      id: task.id,
      workspaceId: task.workspaceId,
      agentId: task.agentId,
      runtimeId: task.runtimeId,
      routerSessionId: task.routerSessionId,
      triggerType: task.triggerType,
      priority: task.priority,
      status: task.status,
      inputJson: task.inputJson,
      queuedAt: task.queuedAt,
    },
  });
}
