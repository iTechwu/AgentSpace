import { claimNextRuntimeAppOperationForRuntimeSync } from "@dofe-agent/db";
import type { ClaimRuntimeAppOperationResponse, RuntimeAppInstallPlan } from "@dofe-agent/domain";
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
  const runtime = readRuntimeForDaemon(runtimeId, auth);
  if (runtime instanceof Response) {
    return runtime;
  }

  const operation = claimNextRuntimeAppOperationForRuntimeSync({
    workspaceId: auth.workspaceId,
    runtimeId: runtime.id,
  });
  if (!operation) {
    return Response.json({ operation: null } satisfies ClaimRuntimeAppOperationResponse);
  }

  const commandPlan = parseCommandPlan(operation.commandPlanJson);
  if (!commandPlan) {
    return Response.json({ error: "runtime_app.invalid_command_plan" }, { status: 500 });
  }

  return Response.json({
    operation: {
      id: operation.id,
      workspaceId: operation.workspaceId,
      runtimeId: operation.runtimeId,
      appSource: operation.appSource,
      appName: operation.appName,
      operation: operation.operation,
      status: operation.status,
      commandPlan,
      createdAt: operation.createdAt,
    },
  } satisfies ClaimRuntimeAppOperationResponse);
}

function parseCommandPlan(value: string): RuntimeAppInstallPlan | null {
  try {
    const parsed = JSON.parse(value) as RuntimeAppInstallPlan;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.commands) ? parsed : null;
  } catch {
    return null;
  }
}
