import type { CompleteSkillInstallationOperationRequest } from "@dofe-agent/domain";
import {
  completeSkillInstallationOperationSync,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import { readSkillInstallationOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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
  const operation = readSkillInstallationOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const body = (await request.json()) as Partial<CompleteSkillInstallationOperationRequest>;
  const completed = completeSkillInstallationOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    safeResultJson: body.safeResultJson,
    componentStatuses: body.componentStatuses,
  });
  if (!completed) {
    return Response.json({ error: "skill.operation_not_completable" }, { status: 409 });
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: `Skill installation ${operation.operation} succeeded`,
    note: `Skill ${operation.operation} for installation "${operation.installationId}" succeeded on runtime "${operation.runtimeId}".`,
    code: `skill_installation.${operation.operation}_succeeded`,
    data: {
      actorType: "daemon_token",
      resourceType: "skill_installation",
      resourceId: operation.installationId,
      runtimeId: operation.runtimeId,
      componentCount: body.componentStatuses?.length ?? 0,
    },
  });

  return Response.json({ operation: { id: operationId, status: "succeeded" } });
}
