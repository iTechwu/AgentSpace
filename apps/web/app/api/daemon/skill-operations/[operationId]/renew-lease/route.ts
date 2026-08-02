import { renewSkillInstallationOperationLeaseSync } from "@dofe-agent/db";
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

  // Fencing: a daemon that lost its lease (crash recovery re-queued the op)
  // cannot renew it; 409 tells it to abort execution.
  const renewed = renewSkillInstallationOperationLeaseSync({ operationId, workspaceId: auth.workspaceId });
  if (!renewed) {
    return Response.json({ error: "skill.operation_lease_lost" }, { status: 409 });
  }
  return Response.json({ operation: { id: operationId, status: existing.status } });
}
