import {
  getDatabase,
  readMcpTaskAuditAuthorizationSync,
  recordMcpToolAuditSync,
  withTransaction,
} from "@dofe-agent/db";
import type {
  ClaimMcpTaskSessionResponse,
  McpToolAuditReport,
  ReportMcpToolAuditsResponse,
} from "@dofe-agent/domain";
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

  let body: { audits?: unknown };
  try {
    body = (await request.json()) as { audits?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.audits)) {
    return Response.json({ error: "audits must be an array." }, { status: 400 });
  }
  const audits = body.audits;
  if (audits.length > 500) {
    return Response.json({ error: "Too many audit records." }, { status: 400 });
  }
  // Audit authorization is a persisted, non-secret claim-time snapshot. It is
  // deliberately retained after the task's secret-bearing session grant is
  // destroyed, so a daemon outbox can safely retry delayed audit delivery.
  const authorization = readMcpTaskAuditAuthorizationSync(taskId, auth.workspaceId);
  if (!authorization || authorization.expiresAt <= new Date().toISOString()) {
    return Response.json({ error: "MCP audit authorization snapshot is unavailable." }, { status: 422 });
  }
  let grantBundle: ClaimMcpTaskSessionResponse;
  try {
    grantBundle = JSON.parse(authorization.authorizationJson) as ClaimMcpTaskSessionResponse;
  } catch {
    return Response.json({ error: "MCP audit authorization snapshot is unreadable." }, { status: 422 });
  }

  const validated: McpToolAuditReport[] = [];
  const eventIds = new Set<string>();
  for (let index = 0; index < audits.length; index += 1) {
    const result = validateAudit(audits[index], taskId, grantBundle, eventIds);
    if (!result.ok) {
      return Response.json(
        { error: result.error, rejectedIndex: index },
        { status: result.status },
      );
    }
    validated.push(result.audit);
  }

  withTransaction(getDatabase(), () => {
    for (const audit of validated) {
      recordMcpToolAuditSync({
        workspaceId: auth.workspaceId,
        connectionId: audit.connectionId,
        taskId,
        toolName: audit.toolName,
        outcome: audit.outcome,
        latencyMs: audit.latencyMs,
        safeSummary: audit.safeSummary?.slice(0, 1000),
        eventId: audit.eventId,
      });
    }
  });
  const response: ReportMcpToolAuditsResponse = {
    recorded: validated.length,
    acceptedEventIds: validated.map((audit) => audit.eventId),
  };
  return Response.json(response);
}

function validateAudit(
  value: unknown,
  taskId: string,
  grant: ClaimMcpTaskSessionResponse,
  eventIds: Set<string>,
):
  | { ok: true; audit: McpToolAuditReport }
  | { ok: false; error: string; status: 400 | 422 } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Audit record must be an object.", status: 400 };
  }
  const audit = value as Partial<McpToolAuditReport>;
  const eventId = typeof audit.eventId === "string" ? audit.eventId.trim() : "";
  if (!eventId || eventId.length > 200 || eventIds.has(eventId)) {
    return { ok: false, error: "Audit eventId must be unique and between 1 and 200 characters.", status: 400 };
  }
  if (audit.taskId !== taskId) {
    return { ok: false, error: "Audit taskId does not match the request path.", status: 400 };
  }
  if (typeof audit.connectionId !== "string" || !audit.connectionId || audit.connectionId.length > 200) {
    return { ok: false, error: "Audit connectionId is invalid.", status: 400 };
  }
  if (typeof audit.toolName !== "string" || !audit.toolName || audit.toolName.length > 128) {
    return { ok: false, error: "Audit toolName is invalid.", status: 400 };
  }
  if (audit.outcome !== "succeeded" && audit.outcome !== "failed") {
    return { ok: false, error: "Audit outcome is invalid.", status: 400 };
  }
  if (
    audit.latencyMs !== undefined &&
    (typeof audit.latencyMs !== "number" || !Number.isFinite(audit.latencyMs) || audit.latencyMs < 0)
  ) {
    return { ok: false, error: "Audit latencyMs is invalid.", status: 400 };
  }
  if (audit.safeSummary !== undefined && typeof audit.safeSummary !== "string") {
    return { ok: false, error: "Audit safeSummary is invalid.", status: 400 };
  }
  const grantedConnection = grant.connections.find((connection) => connection.connectionId === audit.connectionId);
  if (!grantedConnection?.approvedTools.includes(audit.toolName)) {
    return { ok: false, error: "Audit connection or tool was not authorized for this task.", status: 422 };
  }
  eventIds.add(eventId);
  return {
    ok: true,
    audit: {
      connectionId: audit.connectionId,
      taskId,
      toolName: audit.toolName,
      outcome: audit.outcome,
      latencyMs: audit.latencyMs,
      safeSummary: audit.safeSummary,
      eventId,
    },
  };
}
