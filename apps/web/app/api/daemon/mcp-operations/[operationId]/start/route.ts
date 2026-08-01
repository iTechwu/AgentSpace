import { startMcpOperationSync } from "@dofe-agent/db";
import { readMcpOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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
  const existing = readMcpOperationForDaemon(operationId, auth);
  if (existing instanceof Response) {
    return existing;
  }

  const operation = startMcpOperationSync(operationId, auth.workspaceId);
  return Response.json({ operation: { id: operation.id, status: operation.status } });
}
