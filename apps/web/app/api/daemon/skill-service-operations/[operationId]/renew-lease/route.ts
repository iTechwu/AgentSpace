import { renewManagedSkillServiceOperationLeaseSync } from "@dofe-agent/db";
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

  const renewed = renewManagedSkillServiceOperationLeaseSync({ operationId, workspaceId: auth.workspaceId });
  if (!renewed) {
    return Response.json({ error: "skill_service.operation_lease_lost" }, { status: 409 });
  }
  return Response.json({ operation: { id: operationId, status: operation.status } });
}
