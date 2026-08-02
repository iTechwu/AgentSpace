import { McpEgressPolicyCache } from "./policy-cache.ts";
import { McpEgressProxyServer } from "./server.ts";
import { ConsoleMcpEgressAuditSink } from "./audit.ts";

function readEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Environment variable ${key} is required.`);
  }
  return value;
}

async function main(): Promise<void> {
  const port = Number(process.env.MCP_EGRESS_PROXY_PORT ?? "8080");
  const host = process.env.MCP_EGRESS_PROXY_HOST ?? "0.0.0.0";
  const leaseSecret = readEnv("MCP_EGRESS_PROXY_LEASE_SECRET");

  const policyCache = new McpEgressPolicyCache();
  const auditSink = new ConsoleMcpEgressAuditSink();

  const server = new McpEgressProxyServer({
    port,
    host,
    leaseVerifier: {
      leaseSecret,
      fetchPolicySnapshot: (id) => policyCache.get(id),
    },
    auditSink,
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
