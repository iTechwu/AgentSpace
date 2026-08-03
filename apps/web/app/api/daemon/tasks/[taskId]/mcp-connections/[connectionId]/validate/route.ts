import { readMcpConnectionSync } from "@dofe-agent/db";
import type { ValidateMcpConnectionForTaskResponse } from "@dofe-agent/domain";
import { validateMcpConnectionForGatewaySync } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daemon-only: per-call validation of a single MCP connection before the
 * loopback gateway executes a tool. Re-checks the current connection status and
 * the latest discovery snapshot so that disabled or reconfigured connections
 * stop serving already-running task sessions.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string; connectionId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId, connectionId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }
  if (task.status !== "running") {
    return Response.json({ ok: false, reason: "Task is no longer running." }, { status: 409 });
  }

  const connection = readMcpConnectionSync(connectionId, auth.workspaceId);
  if (!connection || connection.runtimeId !== task.runtimeId) {
    return Response.json({ ok: false, reason: "Connection not found for this task." }, { status: 404 });
  }

  const body = (await request.json()) as { toolName?: unknown };
  const toolName = typeof body.toolName === "string" ? body.toolName : "";
  if (!toolName) {
    return Response.json({ ok: false, reason: "toolName is required." }, { status: 400 });
  }

  const result = validateMcpConnectionForGatewaySync({
    workspaceId: auth.workspaceId,
    runtimeId: task.runtimeId,
    taskId: task.id,
    connectionId,
    toolName,
  });

  return Response.json(result satisfies ValidateMcpConnectionForTaskResponse);
}
