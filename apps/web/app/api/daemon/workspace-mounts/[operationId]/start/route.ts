import { startWorkspaceMountOperationSync } from "@dofe-agent/db";
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
  try {
    const started = startWorkspaceMountOperationSync({
      operationId,
      workspaceId: auth.workspaceId,
      claimGeneration: claimGeneration.value,
    });
    return Response.json({ operation: started });
  } catch (error) {
    return Response.json(
      { error: "workspace_mount.not_startable", detail: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
