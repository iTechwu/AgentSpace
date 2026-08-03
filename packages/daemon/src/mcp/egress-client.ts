import { randomUUID } from "node:crypto";
import type { McpEgressPolicySnapshot } from "@dofe-agent/domain";

export interface McpEgressProxyClient {
  baseUrl: string;
  leaseToken: string;
  proxySessionId: string;
  /** Push the policy snapshot to the proxy if it hasn't been pushed yet. */
  ensurePolicyPushed(): Promise<void>;
}

export interface CreateMcpEgressProxyClientInput {
  proxyBaseUrl: string;
  leaseToken: string;
  policySnapshot: McpEgressPolicySnapshot;
  adminToken?: string;
  /** Test hook; production callers use an unguessable UUID generated per transport. */
  proxySessionId?: string;
}

/**
 * Creates a small daemon-side client that pushes a policy snapshot to the proxy
 * and can be used by the SDK transport to add the DofeEgressLease header.
 *
 * Phase 2 uses an in-memory per-process push cache. Production should move to
 * a control-plane → proxy sync feed so multi-replica proxies share state.
 */
export function createMcpEgressProxyClient(input: CreateMcpEgressProxyClientInput): McpEgressProxyClient {
  const pushedPolicyIds = new Set<string>();
  const adminAuthHeader = input.adminToken ? { "x-dofe-admin-token": input.adminToken } : undefined;
  const proxySessionId = input.proxySessionId ?? randomUUID();

  async function ensurePolicyPushed(): Promise<void> {
    const id = input.policySnapshot.revision.id;
    if (pushedPolicyIds.has(id)) return;

    const response = await fetch(`${input.proxyBaseUrl}/v1/admin/policies`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...adminAuthHeader,
      },
      body: JSON.stringify(input.policySnapshot),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "no body");
      throw new Error(`Failed to push policy snapshot to proxy: ${response.status} ${body}`);
    }
    pushedPolicyIds.add(id);
  }

  return {
    baseUrl: input.proxyBaseUrl,
    leaseToken: input.leaseToken,
    proxySessionId,
    ensurePolicyPushed,
  };
}

/** Returns headers that must accompany every MCP request through the proxy. */
export function buildMcpEgressProxyRequestHeaders(client: McpEgressProxyClient): Record<string, string> {
  return {
    Authorization: `DofeEgressLease ${client.leaseToken}`,
    "X-Dofe-Egress-Session": client.proxySessionId,
  };
}
