import { readMcpTaskSessionGrantSync, recordMcpToolAuditSync } from "@dofe-agent/db";
import type { ClaimMcpTaskSessionResponse, McpToolAuditReport } from "@dofe-agent/domain";
import { decryptMcpGrant } from "@dofe-agent/services";
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
  // Validate every audit against the PERSISTED grant snapshot (the immutable
  // authorization this task was granted at claim time), not the connection's
  // CURRENT approvedToolsJson — a tool added or revoked mid-task must not change
  // what the task is allowed to report as having used.
  let grantBundle: ClaimMcpTaskSessionResponse | undefined;
  const grant = readMcpTaskSessionGrantSync(taskId, auth.workspaceId);
  if (grant) {
    try {
      grantBundle = JSON.parse(decryptMcpGrant(grant.encryptedBundleJson)) as ClaimMcpTaskSessionResponse;
    } catch {
      grantBundle = undefined;
    }
  }
  for (const audit of audits) {
    if (!audit || typeof audit.connectionId !== "string" || typeof audit.toolName !== "string") {
      continue;
    }
    // The URL's taskId is authoritative — a client-supplied taskId must never
    // re-attribute an audit to a different task. The connection and tool must be
    // inside the task's claim-time grant snapshot, otherwise the audit is dropped.
    const grantedConnection = grantBundle?.connections.find((c) => c.connectionId === audit.connectionId);
    if (!grantedConnection || !grantedConnection.approvedTools.includes(audit.toolName)) {
      continue;
    }
    recordMcpToolAuditSync({
      workspaceId: auth.workspaceId,
      connectionId: audit.connectionId,
      taskId,
      toolName: audit.toolName.slice(0, 128),
      outcome: audit.outcome === "failed" ? "failed" : "succeeded",
      latencyMs: typeof audit.latencyMs === "number" ? Math.max(0, audit.latencyMs) : undefined,
      safeSummary: typeof audit.safeSummary === "string" ? audit.safeSummary.slice(0, 1000) : undefined,
      eventId: typeof audit.eventId === "string" && audit.eventId.trim() ? audit.eventId.trim() : undefined,
    });
    recorded += 1;
  }
  return Response.json({ recorded });
}
