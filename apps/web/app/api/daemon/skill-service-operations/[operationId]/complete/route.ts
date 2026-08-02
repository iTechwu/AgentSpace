import {
  completeManagedSkillServiceProvisionOperationSync,
  completeManagedSkillServiceRetireOperationSync,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
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
  const parsedClaimGeneration = parseClaimGenerationValue(body.claimGeneration);
  if (!parsedClaimGeneration.ok) {
    return parsedClaimGeneration.response;
  }
  const claimGeneration = parsedClaimGeneration.value;
  const completed = operation.operation === "retire"
    ? completeManagedSkillServiceRetireOperationSync({ operationId, workspaceId: auth.workspaceId, claimGeneration })
    : completeManagedSkillServiceProvisionOperationSync({
        operationId,
        workspaceId: auth.workspaceId,
        claimGeneration,
        endpointRef: typeof body.endpointRef === "string" ? body.endpointRef : "",
        healthRevision: typeof body.healthRevision === "string" ? body.healthRevision : undefined,
      });
  if (!completed.ok) {
    return Response.json({ error: completed.reason }, { status: 400 });
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: "Skill service provisioned",
    note: `Managed service operation "${operationId}" (${operation.operation}) succeeded on runtime "${operation.runtimeId}".`,
    code: `skill_service.${operation.operation}_succeeded`,
    data: {
      actorType: "daemon_token",
      resourceType: "managed_skill_service",
      resourceId: operation.serviceId,
      runtimeId: operation.runtimeId,
      endpointRef: typeof body.endpointRef === "string" ? body.endpointRef : undefined,
    },
  });

  return Response.json({ operation: { id: operationId, status: "succeeded" } });
}
