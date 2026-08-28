import { updateRuntimeAppOperationStageSync } from "@dofe-agent/db";
import type { UpdateRuntimeAppOperationStageRequest } from "@dofe-agent/domain";
import { readRuntimeAppOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STAGES = new Set<UpdateRuntimeAppOperationStageRequest["stage"]>(["installing", "verifying", "finalizing"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;

  const { operationId } = await context.params;
  const existing = readRuntimeAppOperationForDaemon(operationId, auth);
  if (existing instanceof Response) return existing;

  const body = (await request.json().catch(() => ({}))) as Partial<UpdateRuntimeAppOperationStageRequest>;
  if (!body.stage || !ALLOWED_STAGES.has(body.stage)) {
    return Response.json({ error: "runtime_app.stage_invalid" }, { status: 400 });
  }
  const operation = updateRuntimeAppOperationStageSync({
    operationId,
    workspaceId: auth.workspaceId,
    stage: body.stage,
  });
  return Response.json({ operation: { id: operation.id, status: operation.status, stage: operation.stage } });
}
