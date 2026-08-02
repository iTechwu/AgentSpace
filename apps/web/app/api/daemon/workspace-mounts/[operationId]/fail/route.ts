import { failWorkspaceMountOperationSync } from "@dofe-agent/db";
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
    errorCode?: string;
    errorMessage: string;
    runtimeId?: string;
    claimGeneration?: number;
  };
  // The failing daemon must be the one that owns the operation's runtime.
  if (typeof body.runtimeId !== "string" || body.runtimeId !== operation.runtimeId) {
    return Response.json(
      { error: "workspace_mount.runtime_mismatch" },
      { status: 403 },
    );
  }
  if (!Number.isSafeInteger(body.claimGeneration) || (body.claimGeneration ?? 0) <= 0) {
    return Response.json({ error: "workspace_mount.invalid_claim_generation" }, { status: 400 });
  }
  if (typeof body.errorMessage !== "string" || body.errorMessage.trim().length === 0) {
    return Response.json({ error: "workspace_mount.invalid_error" }, { status: 400 });
  }
  let failed;
  try {
    failed = failWorkspaceMountOperationSync({
      operationId,
      workspaceId: auth.workspaceId,
      claimGeneration: body.claimGeneration!,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
    });
  } catch (error) {
    return Response.json(
      { error: "workspace_mount.operation_lease_lost", detail: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }

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
