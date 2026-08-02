import { startManagedSkillServiceOperationSync } from "@dofe-agent/db";
import { readManagedSkillServiceOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import { parseClaimGenerationBody } from "../../../_lib/claim-generation";

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
  const existing = readManagedSkillServiceOperationForDaemon(operationId, auth);
  if (existing instanceof Response) {
    return existing;
  }

  const claimGeneration = await parseClaimGenerationBody(request);
  if (!claimGeneration.ok) {
    return claimGeneration.response;
  }

  const started = startManagedSkillServiceOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    claimGeneration: claimGeneration.value,
  });
  if (!started) {
    return Response.json({ error: "skill_service.operation_not_claimable" }, { status: 409 });
  }
  return Response.json({ operation: { id: operationId, status: "running" } });
}
