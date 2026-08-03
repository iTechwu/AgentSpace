import type { RuntimeToolCapability } from "@dofe-agent/domain";
import type { ProviderHealthSnapshot } from "@dofe-agent/domain";

export const AGENT_ROUTER_HARNESSES = ["claude", "codex", "antigravity", "opencode", "openclaw", "hermes"] as const;

export type AgentRouterHarness = typeof AGENT_ROUTER_HARNESSES[number];

export type AgentRouterOutputFormat = "text" | "json-events";

export interface AgentRouterRunRequest {
  version: 1;
  harness: AgentRouterHarness;
  prompt: string;
  cwd: string;
  executablePath?: string;
  model?: string;
  mode?: string;
  sessionId?: string;
  env?: Record<string, string>;
  /** Keys in `env` that were injected from per-employee Skill configuration. Their values are always redacted from logs, even when the key name does not look like a secret. */
  skillEnvKeys?: string[];
  timeoutMs?: number;
  outputFormat?: AgentRouterOutputFormat;
  maxTurns?: number;
  permissionMode?: string;
  codexApprovalPolicy?: "untrusted" | "on-request" | "never";
  codexFullAccess?: boolean;
  allowedTools?: string[];
  temporaryAllowedTools?: string[];
  claudeTools?: string;
  handleControlRequests?: boolean;
  openClawEphemeralAgent?: boolean;
  providerHealth?: ProviderHealthSnapshot;
  runtimeToolCapabilities?: RuntimeToolCapability[];
  /**
   * Loopback MCP gateway URL (task-scoped session). When set, the provider is
   * launched with a one-shot MCP config pointing ONLY at this URL — the
   * Provider never receives remote endpoints or credentials.
   */
  mcpGatewayUrl?: string;
  /**
   * Codex MCP experiment switch (P1-2): when false, the codex adapter does NOT
   * inject the loopback gateway as `mcp_servers`, even if `mcpGatewayUrl` is
   * set — a gradual-rollout / kill switch for codex MCP isolation before the
   * market eligibility gate passes E2E.
   */
  codexMcpInjectionEnabled?: boolean;
  onApprovalRequest?: (request: AgentRouterApprovalRequest) => Promise<AgentRouterApprovalDecision>;
}

export interface AgentRouterRunResult {
  status: "completed" | "failed" | "cancelled" | "timeout";
  harness: AgentRouterHarness;
  sessionId?: string;
  outputText?: string;
  events: AgentRouterEvent[];
  diagnostics: AgentRouterDiagnostic[];
  exitCode?: number | null;
  signal?: string | null;
  startedAt: string;
  finishedAt: string;
}

export type AgentRouterEvent =
  | { type: "harness_detected"; harness: string; version?: string; path?: string }
  | { type: "harness_started"; harness: string; pid?: number; command: string[] }
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "narration_delta"; text: string }
  | { type: "approval_requested"; toolName: string; toolInput?: Record<string, unknown>; contentPreview: string }
  | { type: "tool_started"; tool: string; title?: string; input?: unknown; toolUseId?: string }
  | { type: "tool_output"; tool: string; output?: string; metadata?: unknown; toolUseId?: string }
  | { type: "tool_finished"; tool: string; status: "completed" | "failed"; toolUseId?: string }
  | { type: "session_updated"; sessionId: string }
  | { type: "harness_exited"; exitCode: number | null; signal?: string | null };

export interface AgentRouterDiagnostic {
  code:
    | "harness.cli_missing"
    | "harness.auth_required"
    | "harness.auth_invalid"
    | "harness.profile_missing"
    | "harness.model_unavailable"
    | "harness.tool_available"
    | "harness.tool_missing"
    | "harness.tool_unauthorized"
    | "harness.tool_permission_denied"
    | "harness.empty_response"
    | "harness.protocol_parse_failed"
    | "harness.timeout"
    | "harness.session_missing"
    | "harness.exited_nonzero"
    | "harness.unknown_failure";
  severity: "info" | "warning" | "error";
  message: string;
  rawProviderMessage?: string;
  stderrTail?: string;
}

export type { RuntimeToolCapability } from "@dofe-agent/domain";

export interface AgentRouterApprovalRequest {
  harness: AgentRouterHarness;
  sessionId?: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  contentPreview: string;
}

export interface AgentRouterApprovalDecision {
  decision: "approved" | "rejected";
  comment?: string;
}

export interface HarnessLaunchPlan {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  metadata?: Record<string, string>;
  stdin?: string;
  keepStdinOpen?: boolean;
  timeoutMs: number;
  redactions: Array<{
    envName?: string;
    pattern?: string;
    replacement: string;
  }>;
}

export interface HarnessDetectionResult {
  id: AgentRouterHarness;
  label: string;
  status: "available" | "missing";
  path?: string;
  version?: string;
}

export interface HarnessErrorContext {
  request: AgentRouterRunRequest;
  plan?: HarnessLaunchPlan;
  stderrTail?: string;
  stdoutTail?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
}

export interface AgentRouterObserver {
  emit(event: AgentRouterEvent): void;
}

export interface HarnessAdapter {
  id: AgentRouterHarness;
  label: string;
  detect(): Promise<HarnessDetectionResult>;
  buildLaunch(input: AgentRouterRunRequest): Promise<HarnessLaunchPlan>;
  run(plan: HarnessLaunchPlan, observer: AgentRouterObserver, request: AgentRouterRunRequest): Promise<AgentRouterRunResult>;
  normalizeError(error: unknown, context: HarnessErrorContext): AgentRouterDiagnostic;
}

export interface HarnessCatalogEntry {
  id: AgentRouterHarness;
  label: string;
}
