import { completeMcpOperationSync, failMcpOperationSync } from "@dofe-agent/db";
import type { CompleteMcpConnectionOperationRequest, McpVerificationResult } from "@dofe-agent/domain";
import { classifyVerificationOutcome, findMissingApprovedMcpTools, redactMcpText, resolveClaimedMcpOperationSync, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { readMcpOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";

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
  const operation = readMcpOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }

  const body = (await request.json()) as Partial<CompleteMcpConnectionOperationRequest>;
  const verification = normalizeVerification(body.verification);

  // The control plane — not the daemon — decides ready vs degraded, by comparing
  // approved tools against what the daemon actually discovered.
  let classifiedVerification = verification;
  if (verification && (operation.operation === "verify" || operation.operation === "enable")) {
    const claimed = resolveClaimedMcpOperationSync({ workspaceId: auth.workspaceId, operation });
    if (!claimed) {
      const failed = failMcpOperationSync({
        operationId,
        workspaceId: auth.workspaceId,
        errorCode: "mcp.policy_denied",
        errorMessage: "MCP connection configuration no longer satisfies the current security policy.",
      });
      tryRecordWorkspaceAuditEventSync({
        workspaceId: auth.workspaceId,
        title: `MCP connection ${operation.operation} denied by policy`,
        note: `MCP ${operation.operation} for connection "${operation.connectionId}" was rejected because its configuration no longer satisfies the current security policy.`,
        code: `mcp_connection.${operation.operation}_policy_denied`,
        data: {
          actorType: "daemon_token",
          resourceType: "mcp_connection",
          resourceId: operation.connectionId,
          runtimeId: operation.runtimeId,
          errorCode: "mcp.policy_denied",
        },
      });
      return Response.json({
        operation: {
          id: failed.id,
          status: failed.status,
          errorMessage: failed.errorMessage,
          completedAt: failed.completedAt,
        },
      });
    }

    const approvedTools = claimed.approvedTools;
    const status = classifyVerificationOutcome(verification, approvedTools);
    const missingApprovedTools = findMissingApprovedMcpTools(verification.discoveredTools ?? [], approvedTools);
    classifiedVerification = {
      ...verification,
      status,
      error: missingApprovedTools.length > 0
        ? {
            code: "mcp.approved_tool_missing",
            safeMessage: `Approved MCP tools are no longer available: ${missingApprovedTools.slice(0, 10).join(", ")}.`,
          }
        : verification.error,
    };
  }

  const completed = completeMcpOperationSync({
    operationId,
    workspaceId: auth.workspaceId,
    safeStdoutTail: redactOptionalText(body.safeStdoutTail),
    safeStderrTail: redactOptionalText(body.safeStderrTail),
    verification: (operation.operation === "verify" || operation.operation === "enable") && classifiedVerification
      ? {
          status: classifiedVerification.status,
          protocolVersion: classifiedVerification.protocolVersion,
          toolsMetadataJson: JSON.stringify(classifiedVerification.discoveredTools ?? []),
          toolsFingerprint: classifiedVerification.toolsFingerprint ?? fingerprintOf(classifiedVerification.discoveredTools),
          latencyMs: classifiedVerification.latencyMs,
          errorCode: classifiedVerification.error?.code,
          errorMessage: classifiedVerification.error?.safeMessage,
        }
      : undefined,
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: `MCP connection ${operation.operation} ${classifiedVerification?.status ?? "succeeded"}`,
    note: `MCP ${operation.operation} for connection "${operation.connectionId}" ${classifiedVerification?.status ?? "succeeded"} on runtime "${operation.runtimeId}".`,
    code: `mcp_connection.${operation.operation === "verify" ? classifiedVerification?.status ?? "verified" : operation.operation}`,
    data: {
      actorType: "daemon_token",
      resourceType: "mcp_connection",
      resourceId: operation.connectionId,
      runtimeId: operation.runtimeId,
      discoveredToolCount: verification?.discoveredTools?.length ?? 0,
      latencyMs: verification?.latencyMs,
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

function redactOptionalText(value: unknown): string | undefined {
  return typeof value === "string" ? redactMcpText(value) : undefined;
}

function fingerprintOf(tools: McpVerificationResult["discoveredTools"]): string {
  if (!tools || tools.length === 0) return "empty";
  return tools
    .map((t) => `${t.name}:${t.inputSchemaDigest}`)
    .sort()
    .join("|");
}

function normalizeVerification(value: Partial<McpVerificationResult> | undefined): McpVerificationResult | undefined {
  if (!value || (value.status !== "ready" && value.status !== "failed" && value.status !== "degraded")) {
    return undefined;
  }
  return {
    status: value.status,
    protocolVersion: typeof value.protocolVersion === "string" ? value.protocolVersion : undefined,
    discoveredTools: Array.isArray(value.discoveredTools)
      ? value.discoveredTools
          .map((tool) => (tool && typeof tool === "object" && typeof tool.name === "string" ? {
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: (tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {}) as Record<string, unknown>,
            inputSchemaDigest: typeof tool.inputSchemaDigest === "string" ? tool.inputSchemaDigest : "",
          } : null))
          .filter((t): t is NonNullable<typeof t> => t !== null)
      : undefined,
    toolsFingerprint: typeof value.toolsFingerprint === "string" ? value.toolsFingerprint : undefined,
    latencyMs: typeof value.latencyMs === "number" ? value.latencyMs : undefined,
    error: value.error && typeof value.error.safeMessage === "string"
      ? { code: value.error.code, safeMessage: value.error.safeMessage }
      : undefined,
  };
}
