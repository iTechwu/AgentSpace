import { completeWorkspaceMountOperationSync, readWorkspaceMountOperationSync } from "@dofe-agent/db";
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

  const body = (await request.json()) as { materializedFiles?: number; mountedPath?: string; runtimeId?: string };
  // The completing daemon must be the one that owns the operation's runtime.
  if (typeof body.runtimeId !== "string" || body.runtimeId !== operation.runtimeId) {
    return Response.json(
      { error: "workspace_mount.runtime_mismatch" },
      { status: 403 },
    );
  }
  const completed = completeWorkspaceMountOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    materializedFiles: body.materializedFiles,
    mountedPath: body.mountedPath,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: "Workspace mount succeeded",
    note: `Workspace for "${operation.employeeName}" materialized on runtime "${operation.runtimeId}" (${body.materializedFiles ?? 0} files).`,
    code: "workspace_mount.succeeded",
    data: {
      actorType: "daemon_token",
      resourceType: "workspace",
      resourceId: operation.employeeName,
      runtimeId: operation.runtimeId,
      materializedFiles: body.materializedFiles ?? 0,
    },
  });

  return Response.json({ operation: { id: operationId, status: completed.status } });
}
