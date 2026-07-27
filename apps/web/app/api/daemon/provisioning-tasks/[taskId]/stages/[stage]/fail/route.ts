import {
  failManagedProvisioningStageSync,
  readAgentRuntimeSync,
  readRuntimeProvisioningTaskSync,
  requestManagedRuntimeCleanupSync,
} from "@dofe-agent/db";
import { requireDaemonAuth } from "../../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string; stage: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId, stage } = await context.params;
  const daemonConnectionId = auth.token.daemonConnectionId;
  if (!daemonConnectionId) {
    return Response.json({ error: "Daemon token is not bound to a connection." }, { status: 403 });
  }

  const task = readRuntimeProvisioningTaskSync(taskId);
  if (!task) {
    return Response.json({ error: "Task not found." }, { status: 404 });
  }
  if (task.workspaceId !== auth.workspaceId || task.daemonConnectionId !== daemonConnectionId) {
    return Response.json({ error: "Task is not assigned to this daemon." }, { status: 403 });
  }
  if (task.stage !== stage) {
    return Response.json({ error: `Task is at stage ${task.stage}, not ${stage}.` }, { status: 409 });
  }

  if (task.status === "cancelling" || task.status === "cancelled" || task.status === "succeeded" || task.status === "failed") {
    return Response.json({ taskId, stage, status: task.status, task });
  }

  const body = (await request.json()) as { errorCode?: string; errorMessage?: string };

  const updated = failManagedProvisioningStageSync({
    taskId,
    stage: task.stage,
    errorCode: body.errorCode,
    errorMessage: body.errorMessage ?? "Stage failed on the node.",
  });

  if (task.runtimeId && updated?.status === "failed") {
    const runtime = readAgentRuntimeSync(task.runtimeId);
    if (runtime?.daemonConnectionId) {
      requestManagedRuntimeCleanupSync({
        runtimeId: runtime.id,
        workspaceId: runtime.workspaceId,
        daemonConnectionId: runtime.daemonConnectionId,
        runtimeType: runtime.provider,
      });
    }
  }

  return Response.json({ taskId, stage, status: updated?.status ?? "failed", task: updated });
}
