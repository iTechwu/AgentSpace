import {
  completeManagedProvisioningStageSync,
  finalizeManagedRuntimeProvisioningSync,
  readRuntimeProvisioningTaskSync,
} from "@dofe-agent/services";
import type { RuntimeProvisioningTaskStage } from "@dofe-agent/db";
import { requireDaemonAuth } from "../../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEXT_STAGE: Record<RuntimeProvisioningTaskStage, RuntimeProvisioningTaskStage | undefined> = {
  pending: undefined,
  request_credential: undefined,
  prepare_node: undefined,
  pull_image: "install_cli",
  install_cli: "write_credential",
  write_credential: "health_check",
  health_check: undefined,
  ready: undefined,
};

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

  const nextStage = NEXT_STAGE[stage as RuntimeProvisioningTaskStage];
  const updated = completeManagedProvisioningStageSync({
    taskId,
    stage: task.stage,
    nextStage,
  });

  if (task.stage === "health_check" && task.runtimeId && updated?.status === "succeeded") {
    finalizeManagedRuntimeProvisioningSync({
      taskId,
      workspaceId: task.workspaceId,
      runtimeId: task.runtimeId,
    });
  }

  return Response.json({
    taskId,
    stage,
    status: "succeeded",
    task: updated,
  });
}
