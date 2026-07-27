import {
  claimManagedProvisioningStageSync,
  readAgentRuntimeSync,
} from "@dofe-agent/db";
import {
  buildManagedProvisioningCommandContext,
  buildManagedProvisioningStageCommands,
} from "@dofe-agent/services";
import { requireDaemonAuth } from "../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const daemonConnectionId = auth.token.daemonConnectionId;
  if (!daemonConnectionId) {
    return Response.json({ error: "Daemon token is not bound to a connection." }, { status: 403 });
  }

  const task = claimManagedProvisioningStageSync({
    daemonConnectionId,
    workspaceId: auth.workspaceId,
  });
  if (!task) {
    return Response.json({ task: null });
  }

  if (!task.runtimeId || !task.runtimeCredentialId) {
    return Response.json({ error: "Task is missing runtime or credential binding." }, { status: 409 });
  }

  const runtime = readAgentRuntimeSync(task.runtimeId);
  if (!runtime) {
    return Response.json({ error: "Runtime not found." }, { status: 404 });
  }

  const context = buildManagedProvisioningCommandContext(runtime);
  const nodeStage = task.stage as "pull_image" | "install_cli" | "health_check" | "cleanup";
  const commands = task.stage === "write_credential"
    ? []
    : buildManagedProvisioningStageCommands(runtime.provider, nodeStage, context);

  return Response.json({
    task: {
      taskId: task.id,
      workspaceId: task.workspaceId,
      runtimeId: task.runtimeId,
      runtimeType: runtime.provider,
      runtimeCredentialId: task.runtimeCredentialId,
      stage: task.stage,
      commands,
    },
  });
}
