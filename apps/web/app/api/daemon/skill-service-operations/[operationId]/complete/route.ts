import {
  completeManagedSkillServiceProvisionOperationSync,
  completeManagedSkillServiceRetireOperationSync,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import { readManagedSkillServiceOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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

  const body = (await request.json()) as { endpointRef?: string; healthRevision?: string; safeResultJson?: string };
  const completed = operation.operation === "retire"
    ? completeManagedSkillServiceRetireOperationSync({ operationId, workspaceId: auth.workspaceId })
    : completeManagedSkillServiceProvisionOperationSync({
        operationId,
        workspaceId: auth.workspaceId,
        endpointRef: body.endpointRef ?? "",
        healthRevision: body.healthRevision,
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
      endpointRef: body.endpointRef,
    },
  });

  return Response.json({ operation: { id: operationId, status: "succeeded" } });
}
