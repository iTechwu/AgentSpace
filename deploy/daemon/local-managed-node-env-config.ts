export const MANAGED_NODE_OPERATIONAL_ENV_KEYS = [
  "MCP_EGRESS_ENFORCE",
  "MCP_EGRESS_PROXY_URL",
  "MCP_EGRESS_PROXY_ADMIN_TOKEN",
  "RUNTIME_SUBNET",
  "PROXY_RUNTIME_IP",
  "CONTROL_PLANE_IPV4",
  "MODELS_GATEWAY_IPV4",
  "DNS_RESOLVER_IPV4",
  "DOFE_SKILL_RUNNER_NODE_IMAGE",
  "DOFE_SKILL_RUNNER_PYTHON_IMAGE",
  "DOFE_SKILL_RUNNER_BASH_IMAGE",
  "DOFE_SKILL_RUNNER_TIMEOUT_MS",
  "DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS",
] as const;

export type ManagedNodeOperationalEnvKey = (typeof MANAGED_NODE_OPERATIONAL_ENV_KEYS)[number];
export type ManagedNodeOperationalEnv = Record<ManagedNodeOperationalEnvKey, string>;

export function resolveManagedNodeOperationalEnv(
  previousSource: string,
  environment: NodeJS.ProcessEnv = process.env,
): ManagedNodeOperationalEnv {
  const value = (key: ManagedNodeOperationalEnvKey, fallback = "") =>
    readEnvValue(environment, key) || readEnvFileValue(previousSource, key) || fallback;

  const resolved: ManagedNodeOperationalEnv = {
    MCP_EGRESS_ENFORCE: value("MCP_EGRESS_ENFORCE", "false"),
    MCP_EGRESS_PROXY_URL: value("MCP_EGRESS_PROXY_URL"),
    MCP_EGRESS_PROXY_ADMIN_TOKEN: value("MCP_EGRESS_PROXY_ADMIN_TOKEN"),
    RUNTIME_SUBNET: value("RUNTIME_SUBNET"),
    PROXY_RUNTIME_IP: value("PROXY_RUNTIME_IP"),
    CONTROL_PLANE_IPV4: value("CONTROL_PLANE_IPV4"),
    MODELS_GATEWAY_IPV4: value("MODELS_GATEWAY_IPV4"),
    DNS_RESOLVER_IPV4: value("DNS_RESOLVER_IPV4"),
    DOFE_SKILL_RUNNER_NODE_IMAGE: value("DOFE_SKILL_RUNNER_NODE_IMAGE"),
    DOFE_SKILL_RUNNER_PYTHON_IMAGE: value("DOFE_SKILL_RUNNER_PYTHON_IMAGE"),
    DOFE_SKILL_RUNNER_BASH_IMAGE: value("DOFE_SKILL_RUNNER_BASH_IMAGE"),
    DOFE_SKILL_RUNNER_TIMEOUT_MS: value("DOFE_SKILL_RUNNER_TIMEOUT_MS", "60000"),
    DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS: value("DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS", "600000"),
  };

  if (!resolved.MCP_EGRESS_PROXY_URL) {
    throw new Error(
      "MCP_EGRESS_PROXY_URL is required. Export it or keep it in the existing .env.managed-node file.",
    );
  }
  if (!resolved.MCP_EGRESS_PROXY_ADMIN_TOKEN) {
    throw new Error(
      "MCP_EGRESS_PROXY_ADMIN_TOKEN is required. Export it or keep it in the existing .env.managed-node file.",
    );
  }

  const proxyUrl = new URL(resolved.MCP_EGRESS_PROXY_URL);
  if (!/^https?:$/.test(proxyUrl.protocol) || proxyUrl.pathname !== "/" || proxyUrl.search || proxyUrl.hash) {
    throw new Error("MCP_EGRESS_PROXY_URL must be an HTTP(S) origin without a path, query, or fragment.");
  }

  for (const [key, entry] of Object.entries(resolved)) {
    if (/[\r\n]/.test(entry)) {
      throw new Error(`${key} must not contain a line break.`);
    }
  }

  return resolved;
}

export function formatManagedNodeOperationalEnv(env: ManagedNodeOperationalEnv): string[] {
  return MANAGED_NODE_OPERATIONAL_ENV_KEYS.map((key) => `${key}=${env[key]}`);
}

function readEnvValue(environment: NodeJS.ProcessEnv, key: string): string {
  return environment[key]?.trim() ?? "";
}

function readEnvFileValue(source: string, key: string): string {
  const prefix = `${key}=`;
  const line = source.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim() ?? "";
}
