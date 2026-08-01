import { startSkillInstallationOperationSync } from "@dofe-agent/db";
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
  const existing = readSkillInstallationOperationForDaemon(operationId, auth);
  if (existing instanceof Response) {
    return existing;
  }

  const started = startSkillInstallationOperationSync({ operationId, workspaceId: auth.workspaceId });
  if (!started) {
    return Response.json({ error: "skill.operation_not_claimable" }, { status: 409 });
  }
  return Response.json({ operation: { id: operationId, status: "running" } });
}
