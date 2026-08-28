import type { DaemonProvider } from "@dofe-agent/domain";

/** Providers whose AgentRouter adapters have a validated MCP gateway injection path. */
export function isMcpRuntimeProviderEligible(provider: DaemonProvider): boolean {
  return (provider === "claude" && process.env.MCP_CLAUDE_EXPERIMENTAL_ENABLED === "1")
    || (provider === "codex" && process.env.MCP_CODEX_EXPERIMENTAL_ENABLED === "1");
}
