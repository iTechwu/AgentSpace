import type { ClaimedMcpConnectionOperation, McpErrorCode, ResolvedMcpConnection } from "@dofe-agent/domain";
import { redactMcpText } from "@dofe-agent/services";
import type { HttpDaemonClient } from "../daemon-client.ts";
import { createRuntimeMcpClient } from "./client.ts";

/**
 * Executes a claimed MCP connection operation (verify / enable / remove) and
 * reports a redacted result back to the control plane. Mirrors
 * executeRemoteRuntimeAppOperation in remote-daemon.ts.
 */
export async function executeMcpConnectionOperation(
  client: HttpDaemonClient,
  operation: ClaimedMcpConnectionOperation,
): Promise<void> {
  await client.startMcpConnectionOperation(operation.id);

  if (operation.operation === "remove") {
    // Nothing to verify server-side; the control plane cascades the delete on complete.
    await client.completeMcpConnectionOperation(operation.id, {});
    return;
  }

  const resolved = resolveConnection(operation);

  try {
    const result = await createRuntimeMcpClient().verify(resolved);
    if (result.status === "failed") {
      await client.failMcpConnectionOperation(operation.id, {
        errorCode: result.error?.code ?? "mcp.protocol_invalid",
        errorMessage: result.error?.safeMessage ?? "MCP verification failed.",
        connectionStatus: operation.source === "health_check" ? "degraded" : undefined,
      });
      return;
    }
    await client.completeMcpConnectionOperation(operation.id, {
      verification: {
        status: result.status,
        protocolVersion: result.protocolVersion,
        discoveredTools: result.discoveredTools,
        toolsFingerprint: result.toolsFingerprint,
        latencyMs: result.latencyMs,
      },
    });
  } catch (error) {
    const message = redactSafe(error);
    await client.failMcpConnectionOperation(operation.id, {
      errorCode: "mcp.protocol_invalid",
      errorMessage: message,
      connectionStatus: operation.source === "health_check" ? "degraded" : undefined,
    });
  }
}

function resolveConnection(operation: ClaimedMcpConnectionOperation): ResolvedMcpConnection {
  return {
    connectionId: operation.connectionId,
    runtimeId: operation.runtimeId,
    workspaceId: operation.workspaceId,
    transport: operation.transport,
    endpoint: operation.endpoint,
    allowedHosts: operation.allowedHosts,
    approvedTools: operation.approvedTools,
    secrets: operation.secrets,
    nonSecretParams: operation.nonSecretParams,
    egressProxyLease: operation.egressProxyLease,
    egressProxyPolicySnapshot: operation.egressProxyPolicySnapshot,
  };
}

function redactSafe(error: unknown): string {
  const raw = String((error as { message?: unknown })?.message ?? error);
  return redactMcpText(raw).slice(0, 240);
}

export type { McpErrorCode };
