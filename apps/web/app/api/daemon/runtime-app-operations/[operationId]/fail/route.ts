import { failRuntimeAppOperationSync } from "@agent-space/db";
import type { FailRuntimeAppOperationRequest } from "@agent-space/domain";
import { tryRecordWorkspaceAuditEventSync } from "@agent-space/services";
import { readRuntimeAppOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { operationId } = await context.params;
  const operation = readRuntimeAppOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const body = (await request.json()) as Partial<FailRuntimeAppOperationRequest>;
  if (!body.errorMessage?.trim()) {
    return Response.json({ error: "errorMessage is required." }, { status: 400 });
  }
  const failed = failRuntimeAppOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    safeStdoutTail: body.safeStdoutTail,
    safeStderrTail: body.safeStderrTail,
    errorCode: body.errorCode,
    errorMessage: body.errorMessage.trim(),
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: `Runtime app ${operation.operation} failed`,
    note: `${operation.appSource}:${operation.appName} ${operation.operation} failed on runtime "${operation.runtimeId}": ${body.errorMessage.trim()}`,
    code: `runtime_app.${operation.operation}_failed`,
    data: {
      actorType: "daemon_token",
      resourceType: "runtime_app",
      resourceId: `${operation.appSource}:${operation.appName}`,
      runtimeId: operation.runtimeId,
    },
  });

  return Response.json({
    operation: {
      id: failed.id,
      status: failed.status,
      errorMessage: failed.errorMessage,
      completedAt: failed.completedAt,
    },
  });
}
