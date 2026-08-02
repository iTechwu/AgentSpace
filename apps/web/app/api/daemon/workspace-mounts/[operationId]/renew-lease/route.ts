import { renewWorkspaceMountOperationLeaseSync } from "@dofe-agent/db";
import { readWorkspaceMountOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";
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
  const operation = readWorkspaceMountOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }
  const claimGeneration = await parseClaimGenerationBody(request);
  if (!claimGeneration.ok) {
    return claimGeneration.response;
  }
  const renewed = renewWorkspaceMountOperationLeaseSync({
    operationId,
    workspaceId: auth.workspaceId,
    claimGeneration: claimGeneration.value,
  });
  if (!renewed) {
    return Response.json({ error: "workspace_mount.operation_lease_lost" }, { status: 409 });
  }
  return Response.json({ operation: { id: operationId, status: operation.status } });
}
