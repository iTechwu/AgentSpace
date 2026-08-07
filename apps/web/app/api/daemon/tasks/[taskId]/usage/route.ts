import type { ReportTaskUsagesRequest, ReportTaskUsagesResponse } from "@dofe-agent/domain";
import { readAgentRuntimeSync } from "@dofe-agent/db";
import { resolveAgentRuntimeMode } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import {
  isPersistableManagedTaskUsage,
  MAX_TASK_USAGE_BATCH_SIZE,
  persistManagedTaskUsagesBestEffort,
} from "../../../_lib/task-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Persist billable gateway responses before a provider task completes. Every
 * incremental record must carry gatewayRequestId because it is the database
 * idempotency key shared with the completion retry path.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;

  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) return task;
  const runtime = readAgentRuntimeSync(task.runtimeId);
  if (!runtime || runtime.workspaceId !== auth.workspaceId) {
    return Response.json({ error: "Runtime does not belong to this workspace." }, { status: 404 });
  }
  if (resolveAgentRuntimeMode() !== "remote" || !runtime.managedCredentialId) {
    return Response.json({ error: "Incremental usage is only available for managed runtimes." }, { status: 409 });
  }

  let body: Partial<ReportTaskUsagesRequest>;
  try {
    body = (await request.json()) as Partial<ReportTaskUsagesRequest>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.usages) || body.usages.length === 0 || body.usages.length > MAX_TASK_USAGE_BATCH_SIZE) {
    return Response.json(
      { error: `usages must contain between 1 and ${MAX_TASK_USAGE_BATCH_SIZE} records.` },
      { status: 400 },
    );
  }
  for (const usage of body.usages) {
    if (
      !usage ||
      typeof usage.gatewayRequestId !== "string" ||
      !usage.gatewayRequestId.trim() ||
      !isPersistableManagedTaskUsage(usage, runtime.managedCredentialId)
    ) {
      return Response.json({ error: "Each usage must contain a valid gatewayRequestId and token snapshot." }, { status: 400 });
    }
  }

  let persisted: boolean;
  try {
    persisted = persistManagedTaskUsagesBestEffort({
      usages: body.usages,
      workspaceId: task.workspaceId,
      taskId: task.id,
      agentId: task.employeeId,
      employeeId: task.employeeId,
      runtimeId: task.runtimeId,
      routerSessionId: task.routerSessionId,
      runtimeCredentialId: runtime.managedCredentialId,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to persist incremental managed usage for task ${task.id}: ${message}`);
      },
    });
  } catch {
    return Response.json(
      { error: "Usage attribution could not be persisted; retry the report." },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }

  const response: ReportTaskUsagesResponse = {
    accepted: body.usages.length,
    pendingReconciliation: !persisted,
  };
  return Response.json(response, { status: persisted ? 200 : 202 });
}
