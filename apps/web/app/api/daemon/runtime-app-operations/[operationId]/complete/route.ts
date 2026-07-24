import { completeRuntimeAppOperationSync } from "@agent-space/db";
import type { CompleteRuntimeAppOperationRequest } from "@agent-space/domain";
import { tryRecordWorkspaceAuditEventSync } from "@agent-space/services";
import { readRuntimeAppOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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
  const operation = readRuntimeAppOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const body = (await request.json()) as Partial<CompleteRuntimeAppOperationRequest>;
  const completed = completeRuntimeAppOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    safeStdoutTail: body.safeStdoutTail,
    safeStderrTail: body.safeStderrTail,
    installedApp: normalizeInstalledApp(body.installedApp),
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: `Runtime app ${operation.operation} succeeded`,
    note: `${operation.appSource}:${operation.appName} ${operation.operation} succeeded on runtime "${operation.runtimeId}".`,
    code: `runtime_app.${operation.operation}_succeeded`,
    data: {
      actorType: "daemon_token",
      resourceType: "runtime_app",
      resourceId: `${operation.appSource}:${operation.appName}`,
      runtimeId: operation.runtimeId,
    },
  });

  return Response.json({
    operation: {
      id: completed.id,
      status: completed.status,
      completedAt: completed.completedAt,
    },
  });
}

function normalizeInstalledApp(
  value: Partial<CompleteRuntimeAppOperationRequest["installedApp"]> | undefined,
): CompleteRuntimeAppOperationRequest["installedApp"] | undefined {
  if (!value || typeof value.displayName !== "string" || !value.displayName.trim()) {
    return undefined;
  }
  return {
    displayName: value.displayName.trim(),
    version: typeof value.version === "string" ? value.version.trim() : undefined,
    entryPoint: typeof value.entryPoint === "string" ? value.entryPoint.trim() : undefined,
    installStrategy: value.installStrategy,
    metadataJson: typeof value.metadataJson === "string" ? value.metadataJson : undefined,
  };
}
