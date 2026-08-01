import type { FailSkillInstallationOperationRequest } from "@dofe-agent/domain";
import {
  failSkillInstallationOperationSync,
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

  const body = (await request.json()) as Partial<FailSkillInstallationOperationRequest>;
  const failed = failSkillInstallationOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    errorCode: body.errorCode,
    errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : "Skill operation failed.",
  });
  if (!failed) {
    return Response.json({ error: "skill.operation_not_failable" }, { status: 409 });
  }

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: `Skill installation ${operation.operation} failed`,
    note: `Skill ${operation.operation} for installation "${operation.installationId}" failed on runtime "${operation.runtimeId}".`,
    code: `skill_installation.${operation.operation}_failed`,
    data: {
      actorType: "daemon_token",
      resourceType: "skill_installation",
      resourceId: operation.installationId,
      runtimeId: operation.runtimeId,
      errorCode: body.errorCode,
    },
  });

  return Response.json({ operation: { id: operationId, status: "failed" } });
}
