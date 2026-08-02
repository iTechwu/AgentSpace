import {
  failSkillInstallationOperationSync,
  parseFailSkillInstallationOperationPayload,
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

  const parsed = parseFailSkillInstallationOperationPayload(await request.json());
  if (!parsed.ok) {
    return Response.json({ error: parsed.reason }, { status: 400 });
  }
  const failed = failSkillInstallationOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    errorCode: parsed.value.errorCode,
    errorMessage: parsed.value.errorMessage,
    componentStatuses: parsed.value.componentStatuses,
  });
  if (!failed.ok) {
    if (failed.code === "component_set_mismatch" || failed.code === "invalid_payload") {
      return Response.json({ error: failed.reason }, { status: 400 });
    }
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
      errorCode: parsed.value.errorCode,
      componentCount: parsed.value.componentStatuses?.length ?? 0,
    },
  });

  return Response.json({ operation: { id: operationId, status: "failed" } });
}
