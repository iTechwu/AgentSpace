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
export function buildClaudeMcpGatewayArgs(url: string): McpGatewayInjection {
  const mcpConfig = JSON.stringify({
    [MCP_GATEWAY_SERVER_KEY]: { type: "http", url },
  });
  return {
    args: ["--mcp-config", mcpConfig, "--strict-mcp-config"],
    redactions: mcpGatewayUrlRedactions(url),
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
export function buildCodexMcpGatewayArgs(url: string): McpGatewayInjection {
  const inlineTable = `{ "${MCP_GATEWAY_SERVER_KEY}" = { url = "${url}", startup_timeout_sec = 30 } }`;
  return {
    args: ["--config", `mcp_servers=${inlineTable}`],
    redactions: mcpGatewayUrlRedactions(url),
  };
}
