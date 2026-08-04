import { updateMcpOperationStageSync } from "@dofe-agent/db";
import type { UpdateMcpConnectionOperationStageRequest } from "@dofe-agent/domain";
import { readMcpOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STAGES = new Set<UpdateMcpConnectionOperationStageRequest["stage"]>([
  "connecting",
  "negotiating",
  "discovering_tools",
  "finalizing",
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;

  const { operationId } = await context.params;
  const existing = readMcpOperationForDaemon(operationId, auth);
  if (existing instanceof Response) return existing;

  const body = (await request.json().catch(() => ({}))) as Partial<UpdateMcpConnectionOperationStageRequest>;
  if (!body.stage || !ALLOWED_STAGES.has(body.stage)) {
    return Response.json({ error: "mcp.stage_invalid" }, { status: 400 });
  }
  const operation = updateMcpOperationStageSync({ operationId, workspaceId: auth.workspaceId, stage: body.stage });
  return Response.json({ operation: { id: operation.id, status: operation.status, stage: operation.stage } });
}
