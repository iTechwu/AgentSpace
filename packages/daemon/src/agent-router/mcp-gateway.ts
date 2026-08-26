import type { HarnessLaunchPlan } from "./types.ts";
import { escapeRegExp } from "./utils.ts";

/**
 * MCP gateway injection layer.
 *
 * The daemon-resident loopback {@link McpGateway} exposes one task-scoped URL
 * per task. Each harness learns about that URL in its own native config format
 * (claude → `--mcp-config` JSON, codex → `--config mcp_servers.*=` TOML). This
 * module centralizes that format knowledge so adding a future harness
 * (openclaw / hermes / opencode / …) is one builder function here, and every
 * harness scrubs the gateway URL — which carries the per-task session token —
 * from captured provider output the same way.
 */

/** Stable server key shared across every harness. Hyphens are legal in both
 *  JSON object keys and TOML bare keys (incl. codex dotted override paths). */
export const MCP_GATEWAY_SERVER_KEY = "dofe-mcp-gateway";

export interface McpGatewayInjection {
  /** argv fragment to append to the harness launch plan. */
  args: string[];
  /** Value-based redactions for the gateway URL (contains the session token). */
  redactions: HarnessLaunchPlan["redactions"];
}

export interface ToolSurfaceMcpServer {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** Reads a provider-facing MCP URL from the generic ToolSurface context. */
export function resolveToolSurfaceMcpUrl(toolSurface: { clientConfig?: unknown } | undefined): string | undefined {
  const config = toolSurface?.clientConfig;
  if (!config || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>).mcpUrl;
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : undefined;
}

/** Resolves one or more provider-facing MCP endpoints from generic context. */
export function resolveToolSurfaceMcpServers(toolSurface: { clientConfig?: unknown } | undefined): ToolSurfaceMcpServer[] {
  const config = toolSurface?.clientConfig;
  if (!config || typeof config !== "object") return [];
  const record = config as Record<string, unknown>;
  if (Array.isArray(record.mcpServers)) {
    return record.mcpServers.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const value = candidate as Record<string, unknown>;
      const headers = value.headers && typeof value.headers === "object"
        ? Object.fromEntries(Object.entries(value.headers as Record<string, unknown>).filter(([, header]) => typeof header === "string")) as Record<string, string>
        : undefined;
      return typeof value.name === "string" && typeof value.url === "string" && /^https?:\/\//.test(value.url)
        ? [{ name: value.name, url: value.url, ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) }]
        : [];
    });
  }
  const url = resolveToolSurfaceMcpUrl(toolSurface);
  return url ? [{ name: "dofe-mcp-connector", url }] : [];
}

/** Redaction that scrubs the gateway URL wherever it appears in provider output. */
export function mcpGatewayUrlRedactions(url: string): HarnessLaunchPlan["redactions"] {
  if (!url) return [];
  return [{
    pattern: escapeRegExp(url),
    replacement: "[redacted:mcp-gateway-url]",
  }];
}

/**
 * Claude Code: one-shot, task-scoped MCP config passed inline as JSON.
 * `--strict-mcp-config` suppresses any ambient servers the user configured.
 */
export function buildClaudeMcpGatewayArgs(url: string, serverKey = MCP_GATEWAY_SERVER_KEY): McpGatewayInjection {
  return buildClaudeMcpServerArgs([{ name: serverKey, url }]);
}

export function buildClaudeMcpServerArgs(servers: ToolSurfaceMcpServer[]): McpGatewayInjection {
  const mcpServers = Object.fromEntries(servers.map((server) => [server.name, {
    type: "http",
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
  }]));
  const mcpConfig = JSON.stringify({ mcpServers });
  return {
    args: ["--mcp-config", mcpConfig, "--strict-mcp-config"],
    redactions: servers.flatMap((server) => mcpGatewayUrlRedactions(server.url)),
  };
}

/**
 * Codex CLI: MCP servers live under `[mcp_servers.<name>]` in TOML. We replace
 * the whole `mcp_servers` key with a TOML inline table containing only the
 * gateway, so any MCP server the user or a project pre-configured does not leak
 * into a task (combined with `--ignore-user-config` emitted by the codex
 * adapter, which blanks the `$CODEX_HOME/config.toml` layer). codex's override
 * parser splits on the first `=` only, so the inner `= { … }` is preserved.
 *
 * NOTE: codex has no flag that fully disables project/cloud config layers, so
 * this is best-effort isolation; the MCP market eligibility gate stays closed
 * for codex (experimental flag) until real E2E validates the isolation.
 *
 * `startup_timeout_sec` tolerates the gateway's lazy listener warm-up.
 */
/**
 * P1-2 Codex MCP experiment switch: the gateway injection applies only when a
 * session URL is present AND the switch is explicitly enabled. The unverified
 * Codex MCP path stays fail-closed without affecting Claude MCP sessions.
 */
export function shouldInjectCodexMcpGateway(input: {
  mcpGatewayUrl?: string;
  codexMcpInjectionEnabled?: boolean;
}): boolean {
  return Boolean(input.mcpGatewayUrl) && input.codexMcpInjectionEnabled === true;
}

export function buildCodexMcpGatewayArgs(url: string, serverKey = MCP_GATEWAY_SERVER_KEY): McpGatewayInjection {
  return buildCodexMcpServerArgs([{ name: serverKey, url }]);
}

export function buildCodexMcpServerArgs(servers: ToolSurfaceMcpServer[]): McpGatewayInjection {
  const inlineTable = `{ ${servers.map((server) => {
    const headers = server.headers && Object.keys(server.headers).length > 0
      ? `, http_headers = ${formatTomlInlineTable(server.headers)}`
      : "";
    return `"${server.name}" = { url = "${server.url}", startup_timeout_sec = 30${headers} }`;
  }).join(", ")} }`;
  return {
    args: ["--config", `mcp_servers=${inlineTable}`],
    redactions: servers.flatMap((server) => mcpGatewayUrlRedactions(server.url)),
  };
}

function formatTomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) =>
    `"${escapeTomlString(key)}" = "${escapeTomlString(value)}"`,
  );
  return `{ ${entries.join(", ")} }`;
}

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}
