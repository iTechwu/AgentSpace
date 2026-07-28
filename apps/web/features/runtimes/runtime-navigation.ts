import type { AgentRuntimeMode } from "@dofe-agent/services";

export function getRuntimeManagementPath(runtimeMode: AgentRuntimeMode): string {
  return runtimeMode === "remote" ? "/runtimes" : "/agents?mode=container";
}

export function isLegacyRuntimeManagementRequest(
  runtimeMode: AgentRuntimeMode,
  agentsMode: string | undefined,
): boolean {
  return runtimeMode === "remote" && agentsMode === "container";
}
