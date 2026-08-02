import {
  completeSkillInstallationOperationSync,
  parseCompleteSkillInstallationOperationPayload,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import { readSkillInstallationOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import { parseJsonObjectBody } from "../../../_lib/claim-generation";

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

  const body = await parseJsonObjectBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = parseCompleteSkillInstallationOperationPayload(body.value);
  if (!parsed.ok) {
    return Response.json({ error: parsed.reason }, { status: 400 });
  }
  const completed = completeSkillInstallationOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    claimGeneration: parsed.value.claimGeneration,
    safeResultJson: parsed.value.safeResultJson,
    componentStatuses: parsed.value.componentStatuses,
  });
  if (!completed.ok) {
    if (completed.code === "evidence_mismatch" || completed.code === "component_set_mismatch" || completed.code === "invalid_payload") {
      return Response.json({ error: completed.reason }, { status: 400 });
    }
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
      componentCount: parsed.value.componentStatuses?.length ?? 0,
    },
  });

  return Response.json({ operation: { id: operationId, status: "succeeded" } });
}
