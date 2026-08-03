import { claimNextManagedSkillServiceOperationForRuntimeSync } from "@dofe-agent/db";
import { resolveClaimedManagedSkillServiceOperation } from "@dofe-agent/services";
import type { ClaimManagedSkillServiceOperationResponse } from "@dofe-agent/domain";
import { readRuntimeForDaemon, requireDaemonAuth } from "../../../../../_lib/auth";

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

  const operation = claimNextManagedSkillServiceOperationForRuntimeSync({
    workspaceId: auth.workspaceId,
    runtimeId: runtime.id,
  });
  if (!operation) {
    return Response.json({ operation: null } satisfies ClaimManagedSkillServiceOperationResponse);
  }
  const claimed = resolveClaimedManagedSkillServiceOperation(operation);
  if (!claimed) {
    return Response.json({ operation: null } satisfies ClaimManagedSkillServiceOperationResponse);
  }
  return Response.json({ operation: claimed } satisfies ClaimManagedSkillServiceOperationResponse);
}
