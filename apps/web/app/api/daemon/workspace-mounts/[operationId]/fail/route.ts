import { failWorkspaceMountOperationSync, readWorkspaceMountOperationSync } from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { requireDaemonAuth } from "../../../_lib/auth";

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
  const operation = readWorkspaceMountOperationSync(operationId, auth.workspaceId);
  if (!operation) {
    return Response.json({ error: "workspace_mount.not_found" }, { status: 404 });
  }

  const body = (await request.json()) as { errorCode?: string; errorMessage: string; runtimeId?: string };
  // The failing daemon must be the one that owns the operation's runtime.
  if (typeof body.runtimeId !== "string" || body.runtimeId !== operation.runtimeId) {
    return Response.json(
      { error: "workspace_mount.runtime_mismatch" },
      { status: 403 },
    );
  }
  const failed = failWorkspaceMountOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    errorCode: body.errorCode,
    errorMessage: body.errorMessage,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: "Workspace mount failed",
    note: `Workspace for "${operation.employeeName}" failed to materialize on runtime "${operation.runtimeId}".`,
    code: "workspace_mount.failed",
    data: {
      actorType: "daemon_token",
      resourceType: "workspace",
      resourceId: operation.employeeName,
      runtimeId: operation.runtimeId,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
    },
  });

  return Response.json({ operation: { id: operationId, status: failed.status } });
}
