import { claimNextWorkspaceMountOperationForRuntimeSync } from "@dofe-agent/db";
import type { ClaimWorkspaceMountOperationResponse } from "@dofe-agent/domain";
import { readRuntimeForDaemon, requireDaemonAuth } from "../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runtimeId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { runtimeId } = await context.params;
  const runtime = readRuntimeForDaemon(runtimeId, auth, { requireOnline: true });
  if (runtime instanceof Response) {
    return runtime;
  }

  const claimed = claimNextWorkspaceMountOperationForRuntimeSync(runtime.id, auth.workspaceId);
  if (!claimed) {
    return Response.json({ operation: null } satisfies ClaimWorkspaceMountOperationResponse);
  }

  return Response.json({
    operation: {
      operationId: claimed.id,
      workspaceId: claimed.workspaceId,
      runtimeId: claimed.runtimeId,
      employeeName: claimed.employeeName,
      headRevisionId: claimed.headRevisionId,
      claimGeneration: claimed.claimGeneration,
    },
  } satisfies ClaimWorkspaceMountOperationResponse);
}
