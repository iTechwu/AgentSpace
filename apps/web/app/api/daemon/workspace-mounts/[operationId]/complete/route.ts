import { completeWorkspaceMountOperationSync } from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { readWorkspaceMountOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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
  const operation = readWorkspaceMountOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const body = (await request.json()) as {
    materializedFiles?: number;
    mountedPath?: string;
    runtimeId?: string;
    claimGeneration?: number;
  };
  // The completing daemon must be the one that owns the operation's runtime.
  if (typeof body.runtimeId !== "string" || body.runtimeId !== operation.runtimeId) {
    return Response.json(
      { error: "workspace_mount.runtime_mismatch" },
      { status: 403 },
    );
  }
  if (
    typeof body.materializedFiles !== "number" ||
    !Number.isSafeInteger(body.materializedFiles) ||
    body.materializedFiles < 0 ||
    typeof body.mountedPath !== "string" ||
    !Number.isSafeInteger(body.claimGeneration) ||
    (body.claimGeneration ?? 0) <= 0 ||
    body.mountedPath.trim().length === 0
  ) {
    return Response.json({ error: "workspace_mount.invalid_evidence" }, { status: 400 });
  }
  let completed;
  try {
    completed = completeWorkspaceMountOperationSync({
      operationId,
      workspaceId: auth.workspaceId,
      claimGeneration: body.claimGeneration!,
      materializedFiles: body.materializedFiles,
      mountedPath: body.mountedPath,
    });
  } catch (error) {
    return Response.json(
      { error: "workspace_mount.operation_lease_lost", detail: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }

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
