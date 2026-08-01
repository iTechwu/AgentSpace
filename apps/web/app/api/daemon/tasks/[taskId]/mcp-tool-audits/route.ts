import { recordMcpToolAuditSync } from "@dofe-agent/db";
import type { McpToolAuditReport } from "@dofe-agent/domain";
import { readTaskForDaemon, requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daemon-only: persists redacted MCP tool-call audits reported by the loopback
 * gateway. Raw arguments and outputs are never transmitted.
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

  const body = (await request.json()) as { audits?: McpToolAuditReport[] };
  const audits = Array.isArray(body.audits) ? body.audits : [];
  if (audits.length > 500) {
    return Response.json({ error: "Too many audit records." }, { status: 400 });
  }
  let recorded = 0;
  for (const audit of audits) {
    if (!audit || typeof audit.connectionId !== "string" || typeof audit.toolName !== "string") {
      continue;
    }
    recordMcpToolAuditSync({
      workspaceId: auth.workspaceId,
      connectionId: audit.connectionId,
      taskId: audit.taskId || taskId,
      toolName: audit.toolName.slice(0, 128),
      outcome: audit.outcome === "failed" ? "failed" : "succeeded",
      latencyMs: typeof audit.latencyMs === "number" ? Math.max(0, audit.latencyMs) : undefined,
      safeSummary: typeof audit.safeSummary === "string" ? audit.safeSummary.slice(0, 1000) : undefined,
    });
    recorded += 1;
  }
  return Response.json({ recorded });
}
