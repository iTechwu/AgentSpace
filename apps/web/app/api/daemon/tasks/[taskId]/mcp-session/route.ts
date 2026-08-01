import { readAgentRuntimeSync } from "@dofe-agent/db";
import type { ClaimMcpTaskSessionResponse } from "@dofe-agent/domain";
import { claimMcpTaskSessionSync } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daemon-only: claims a one-time resolved MCP connection bundle for a running
 * task. The Provider-visible input bundle carries no endpoint, configuration,
 * or credentials; this response is delivered only to the daemon process, which
 * keeps the resolved connections in memory for its loopback MCP gateway.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { taskId } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) {
    return task;
  }
  if (task.status !== "running") {
    return Response.json(
      { error: `MCP session claim requires a running task (status: ${task.status}).` },
      { status: 409 },
    );
  }

  const runtime = readAgentRuntimeSync(task.runtimeId);
  if (!runtime || runtime.workspaceId !== auth.workspaceId) {
    return Response.json({ error: `Runtime "${task.runtimeId}" does not exist.` }, { status: 404 });
  }

  const session = claimMcpTaskSessionSync({
    workspaceId: auth.workspaceId,
    runtimeId: runtime.id,
    taskId: task.id,
  });

  return Response.json(session satisfies ClaimMcpTaskSessionResponse);
}
