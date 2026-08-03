import { readMcpEgressLeaseVerificationKey } from "@dofe-agent/services/mcp-center/egress";
import { McpEgressPolicyCache } from "./policy-cache.ts";
import { McpEgressMetrics } from "./metrics.ts";
import { McpEgressProxyServer } from "./server.ts";
import { ConsoleMcpEgressAuditSink } from "./audit.ts";
import { SingleReplicaJtiReplayGuard } from "./jti-replay-guard.ts";

async function main(): Promise<void> {
  const port = Number(process.env.MCP_EGRESS_PROXY_PORT ?? "8080");
  const host = process.env.MCP_EGRESS_PROXY_HOST ?? "0.0.0.0";
  const leaseVerificationKey = readMcpEgressLeaseVerificationKey();
  if (!leaseVerificationKey) {
    throw new Error(
      "MCP_EGRESS_PROXY_LEASE_VERIFY_PUBLIC_KEY_FILE is required; legacy HMAC also requires MCP_EGRESS_PROXY_ALLOW_LEGACY_HMAC=true.",
    );
  }

  // P1-1 持久重放: with a state file, a proxy restart replays the pushed
  // policy/revoke feed instead of starting empty.
  const stateFile = process.env.MCP_EGRESS_PROXY_STATE_FILE;
  const replayStateFile = process.env.MCP_EGRESS_PROXY_JTI_STATE_FILE ?? (stateFile ? `${stateFile}.jti` : undefined);
  const policyCache = new McpEgressPolicyCache(stateFile ? { stateFile } : {});
  const metrics = new McpEgressMetrics();
  const auditSink = new ConsoleMcpEgressAuditSink();
  const replayGuard = new SingleReplicaJtiReplayGuard(replayStateFile ? { stateFile: replayStateFile } : {});

  // Admin token rotation: MCP_EGRESS_PROXY_ADMIN_TOKENS (comma-separated) may
  // carry the previous + next token during a rotation window.
  const rawTokens = process.env.MCP_EGRESS_PROXY_ADMIN_TOKENS?.trim();
  const adminTokens = rawTokens
    ? new Set(rawTokens.split(",").map((token) => token.trim()).filter(Boolean))
    : undefined;

  const server = new McpEgressProxyServer({
    port,
    host,
    leaseVerifier: {
      leaseVerificationKey,
      fetchPolicySnapshot: (id) => policyCache.get(id),
      bindJtiToSession: (jti, sessionId, exp) => replayGuard.bind(jti, sessionId, exp),
      consumeTaskCallJti: (jti) => replayGuard.consumeTaskCall(jti),
    },
    policyCache,
    auditSink,
    metrics,
    adminToken: process.env.MCP_EGRESS_PROXY_ADMIN_TOKEN,
    ...(adminTokens && adminTokens.size > 0 ? { adminTokens } : {}),
  });

  const { url, close } = await server.start();
  console.log(`MCP egress proxy listening on ${url}`);

  const shutdown = () => {
    close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
