import { failManagedSkillServiceOperationSync } from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { readManagedSkillServiceOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import { parseClaimGenerationValue, parseJsonObjectBody } from "../../../_lib/claim-generation";

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
  const operation = readManagedSkillServiceOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const parsedBody = await parseJsonObjectBody(request);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.value;
  const claimGeneration = parseClaimGenerationValue(body.claimGeneration);
  if (!claimGeneration.ok) {
    return claimGeneration.response;
  }
  if (typeof body.errorMessage !== "string" || !body.errorMessage.trim()) {
    return Response.json({ error: "errorMessage is required." }, { status: 400 });
  }

  const failed = failManagedSkillServiceOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    claimGeneration: claimGeneration.value,
    errorCode: typeof body.errorCode === "string" && body.errorCode.trim()
      ? body.errorCode.trim()
      : "skill_service.operation_failed",
    errorMessage: body.errorMessage.trim(),
  });
  if (!failed) {
    return Response.json({ error: "skill_service.operation_not_failable" }, { status: 409 });
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: "Skill service operation failed",
    note: `Managed service operation "${operationId}" (${operation.operation}) failed on runtime "${operation.runtimeId}".`,
    code: `skill_service.${operation.operation}_failed`,
    data: {
      actorType: "daemon_token",
      resourceType: "managed_skill_service",
      resourceId: operation.serviceId,
      runtimeId: operation.runtimeId,
      errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
    },
  });

  return Response.json({ operation: { id: operationId, status: "failed" } });
}
