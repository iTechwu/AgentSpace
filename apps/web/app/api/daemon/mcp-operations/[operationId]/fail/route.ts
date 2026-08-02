import { failMcpConnectionOperationWithHealthScheduleSync } from "@dofe-agent/services";
import type { FailMcpConnectionOperationRequest } from "@dofe-agent/domain";
import { redactMcpText, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { readMcpOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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
  const operation = readMcpOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const body = (await request.json()) as Partial<FailMcpConnectionOperationRequest>;
  if (!body.errorMessage?.trim()) {
    return Response.json({ error: "errorMessage is required." }, { status: 400 });
  }
  const safeErrorMessage = redactMcpText(body.errorMessage.trim());
  const failed = failMcpConnectionOperationWithHealthScheduleSync({
    operationId,
    workspaceId: auth.workspaceId,
    safeStdoutTail: typeof body.safeStdoutTail === "string" ? redactMcpText(body.safeStdoutTail) : undefined,
    safeStderrTail: typeof body.safeStderrTail === "string" ? redactMcpText(body.safeStderrTail) : undefined,
    errorCode: body.errorCode,
    errorMessage: safeErrorMessage,
    connectionStatus: body.connectionStatus,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: `MCP connection ${operation.operation} failed`,
    note: `MCP ${operation.operation} for connection "${operation.connectionId}" failed: ${safeErrorMessage}`,
    code: `mcp_connection.${operation.operation}_failed`,
    data: {
      actorType: "daemon_token",
      resourceType: "mcp_connection",
      resourceId: operation.connectionId,
      runtimeId: operation.runtimeId,
      errorCode: body.errorCode,
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
