import { claimNextMcpOperationForRuntimeSync } from "@dofe-agent/db";
import type { ClaimMcpConnectionOperationResponse } from "@dofe-agent/domain";
import { resolveClaimedMcpOperationSync } from "@dofe-agent/services";
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

  const claimed = claimNextMcpOperationForRuntimeSync({
    workspaceId: auth.workspaceId,
    runtimeId: runtime.id,
  });
  if (!claimed) {
    return Response.json({ operation: null } satisfies ClaimMcpConnectionOperationResponse);
  }

  const operation = resolveClaimedMcpOperationSync({ workspaceId: auth.workspaceId, operation: claimed });
  if (!operation) {
    return Response.json({ error: "mcp.connection_not_found" }, { status: 404 });
  }

  return Response.json({ operation } satisfies ClaimMcpConnectionOperationResponse);
}
