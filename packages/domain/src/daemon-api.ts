import type { DaemonProvider } from "./daemon-provider.js";
import type { EmployeeExecutionPolicy } from "./workspace.js";

export const PROVIDER_ERROR_CODES = [
  "provider.cli_missing",
  "provider.auth_invalid",
  "provider.profile_missing",
  "provider.subscription_invalid",
  "provider.rate_limited",
  "provider.model_unavailable",
  "provider.profile_missing",
  "provider.session_invalid",
  "provider.tool_missing",
  "provider.tool_unauthorized",
  "provider.tool_permission_denied",
  "provider.document_read_denied",
  "provider.document_edit_denied",
  "provider.document_forward_denied",
  "provider.document_external_auth_unavailable",
  "provider.empty_response",
  "provider.empty_response.stdout_empty",
  "provider.empty_response.no_result_event",
  "provider.empty_response.no_text_event",
  "provider.protocol_parse_failed",
  "provider.timeout",
  "provider.runtime_generic_failure",
] as const;

export type RuntimeOnlineStatus = "online" | "offline";
export type ProviderHealthStatus = "unknown" | "healthy" | "degraded" | "broken";
export type ProviderUsabilityStatus = "usable" | "unverified" | "unusable";
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];
export type ProviderErrorCategory =
  | "provider"
  | "runtime"
  | "configuration"
  | "auth"
  | "profile"
  | "model"
  | "tool"
  | "protocol"
  | "unknown";
export type RuntimeAppCatalogSource = "clihub_harness" | "clihub_public" | "skill_dependency";
export type RuntimeAppInstallStrategy = "cli_hub" | "pip" | "npm" | "uv" | "bundled" | "manual";
export type RuntimeAppOperationType = "install" | "update" | "uninstall" | "verify" | "disable" | "enable";
export type RuntimeAppOperationStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type RuntimeAppRiskLevel = "low" | "medium" | "high";

export interface ProviderStructuredError {
  code: ProviderErrorCode;
  category?: ProviderErrorCategory;
  provider?: DaemonProvider;
  message?: string;
  rawProviderMessage?: string;
}

export interface ProviderHealthSnapshot {
  status: ProviderHealthStatus;
  reason?: string;
  checkedAt?: string;
  error?: ProviderStructuredError;
}

export interface RuntimeProviderHealth {
  runtimeStatus: RuntimeOnlineStatus;
  providerHealth: ProviderHealthStatus;
  providerUsable: ProviderUsabilityStatus;
  providerHealthReason?: string;
  lastHealthCheckedAt?: string;
  lastProviderErrorCode?: ProviderErrorCode;
  lastProviderErrorMessage?: string;
  rawProviderMessage?: string;
}

export interface DaemonRuntimeInfo {
  provider: DaemonProvider;
  providerAccountId?: string;
  name: string;
  version?: string;
  deviceInfo?: string;
  metadata?: Record<string, unknown>;
  maxConcurrentTasks?: number;
}

export interface RegisterDaemonRequest {
  daemonKey: string;
  deviceName: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
  runtimes: DaemonRuntimeInfo[];
}

export interface RegisterDaemonResponse {
  daemon: {
    daemonKey: string;
    status: "online" | "offline";
    workspaceId: string;
  };
  runtimes: Array<{
    id: string;
    provider: DaemonProvider;
    name: string;
    status: "online" | "offline";
  }>;
}

export interface HeartbeatDaemonRequest {
  daemonKey: string;
  metadata?: Record<string, unknown>;
  runtimes?: Array<{
    id?: string;
    provider?: DaemonProvider;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ManagedProvisioningCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ManagedCredentialBundleDocument {
  version: 1;
  /** Opaque credential generation identifier used to invalidate node caches. */
  credentialId: string;
  environment: Record<string, string>;
  files: Record<string, string>;
}

export type ManagedProvisioningStage =
  | "pull_image"
  | "install_cli"
  | "write_credential"
  | "health_check"
  | "cleanup";

export interface ManagedProvisioningTask {
  taskId: string;
  workspaceId: string;
  runtimeId: string;
  runtimeType: DaemonProvider;
  runtimeCredentialId: string;
  stage: ManagedProvisioningStage;
  commands: ManagedProvisioningCommand[];
}

export interface ClaimManagedProvisioningTaskResponse {
  task: ManagedProvisioningTask | null;
}

export interface CompleteManagedProvisioningStageRequest {
  runtimeId: string;
}

export interface CompleteManagedProvisioningStageResponse {
  taskId: string;
  stage: ManagedProvisioningStage;
  status: "succeeded";
}

export interface FailManagedProvisioningStageRequest {
  runtimeId: string;
  errorCode: string;
  errorMessage: string;
}

export interface FailManagedProvisioningStageResponse {
  taskId: string;
  stage: ManagedProvisioningStage;
  status: "failed";
}

export interface ManagedRuntimeCleanupRequest {
  requestId: string;
  workspaceId: string;
  runtimeId: string;
  runtimeType: DaemonProvider;
  commands: ManagedProvisioningCommand[];
}

export interface CompleteManagedRuntimeCleanupRequest {
  result?: Record<string, unknown>;
}

export interface HeartbeatDaemonResponse {
  daemon: {
    daemonKey: string;
    status: "online" | "offline";
    workspaceId: string;
    lastHeartbeatAt?: string;
  };
  runtimes: Array<{
    id: string;
    provider: DaemonProvider;
    status: "online" | "offline";
    lastHeartbeatAt?: string;
    metadata?: Record<string, unknown>;
  }>;
  managedRuntimeCleanupRequests: ManagedRuntimeCleanupRequest[];
}

export interface ClaimedDaemonTask {
  id: string;
  workspaceId: string;
  agentId: string;
  runtimeId: string;
  routerSessionId?: string;
  triggerType: string;
  priority: number;
  status: string;
  inputJson: string;
  queuedAt: string;
  /** Binding generation captured at claim time; completion must match this lease. */
  bindingGeneration?: number;
}

export interface ClaimTaskResponse {
  task: ClaimedDaemonTask | null;
}

/** Daemon workspace-mount operation: materialize an employee's head revision onto a runtime. */
export interface ClaimedWorkspaceMountOperation {
  operationId: string;
  workspaceId: string;
  runtimeId: string;
  employeeName: string;
  headRevisionId?: string;
}

export interface ClaimWorkspaceMountOperationResponse {
  operation: ClaimedWorkspaceMountOperation | null;
}

export interface CompleteWorkspaceMountOperationRequest {
  materializedFiles?: number;
  /** Daemon-local path of the persistent runtime workspace (kept after mount). */
  mountedPath?: string;
  /** The daemon's runtime; the control plane verifies it owns the operation. */
  runtimeId: string;
}

export interface FailWorkspaceMountOperationRequest {
  errorCode?: string;
  errorMessage: string;
  /** The daemon's runtime; the control plane verifies it owns the operation. */
  runtimeId: string;
}

export interface DaemonTaskMessageInput {
  type: string;
  content?: string;
  tool?: string;
  inputJson?: Record<string, unknown>;
  output?: string;
}

export interface ReportTaskMessagesRequest {
  messages: DaemonTaskMessageInput[];
}

export interface FailTaskRequest {
  errorText: string;
  runtimeCredentialId?: string;
  errorCode?: ProviderErrorCode;
  errorCategory?: ProviderErrorCategory;
  provider?: DaemonProvider;
  rawProviderMessage?: string;
  sessionId?: string;
  workDir?: string;
}

export interface DaemonBundleFile {
  path: string;
  contentBase64: string;
  /** Octal permission string, e.g. "0755" / "0644". */
  mode?: string;
}

export interface DaemonTaskInputBundle {
  version: 1;
  format: "json-inline-v1";
  taskId: string;
  runtimeId: string;
  prompt: string;
  metadata: {
    taskTitle?: string;
    taskTriggerType: string;
    channelName?: string;
    contactId?: string;
    skillEnv?: Record<string, string>;
    skillEnvConflicts?: string[];
    skillReadinessBlockers?: string[];
    effectiveModel?: {
      modelId: string;
      source: "session_override" | "employee_default" | "skill_requirement" | "runtime_default" | "team_policy_default" | "protocol_fallback";
      runtimeCredentialId: string;
    };
    executionPolicy?: EmployeeExecutionPolicy;
    runtimeApps?: {
      status: "available" | "none";
      apps: RuntimeAppContextEntry[];
    };
    runtimeToolCapabilities?: {
      status: "available" | "none";
      capabilities: RuntimeToolCapability[];
    };
    mcpConnections?: {
      status: "available" | "none";
      connections: RuntimeMcpConnectionContextEntry[];
    };
    routerSession?: {
      routerSessionId: string;
      conversationKey?: string;
      sourceType?: string;
      providerSessionId?: string;
      continuationMode: "same_provider_resume" | "cold_rebuild" | "fallback";
      selectedRuntimeId: string;
      previousRuntimeId?: string;
      fallbackReason?: string;
      attemptCount: number;
    };
  };
  files: DaemonBundleFile[];
}

export interface RuntimeToolCapability {
  id: string;
  command: string;
  displayName?: string;
  binPath?: string;
  binDir?: string;
  pathDirs?: string[];
  env?: Record<string, string>;
  allowedShellPatterns: string[];
  diagnosticCommands?: string[];
  requiresApproval?: boolean;
  source: "builtin" | "cli-hub" | "workspace" | "runtime";
  status?: "available" | "denied" | "missing";
  denialReason?: string;
}

export interface RuntimeAppContextEntry {
  source: RuntimeAppCatalogSource;
  name: string;
  displayName: string;
  version?: string;
  entryPoint?: string;
  skillMd?: string;
  requiresText?: string;
  category?: string;
}

export interface RuntimeAppCommandPlanItem {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RuntimeAppInstallPlan {
  app: {
    source: RuntimeAppCatalogSource;
    name: string;
    version: string;
    entryPoint: string;
  };
  strategy: RuntimeAppInstallStrategy;
  commands: RuntimeAppCommandPlanItem[];
  verifyCommands: RuntimeAppCommandPlanItem[];
  risk: RuntimeAppRiskLevel;
  requiresApproval: boolean;
  notes: string[];
}

export interface ClaimedRuntimeAppOperation {
  id: string;
  workspaceId: string;
  runtimeId: string;
  appSource: RuntimeAppCatalogSource;
  appName: string;
  operation: RuntimeAppOperationType;
  status: RuntimeAppOperationStatus;
  commandPlan: RuntimeAppInstallPlan;
  createdAt: string;
}

export interface ClaimRuntimeAppOperationResponse {
  operation: ClaimedRuntimeAppOperation | null;
}

/** Managed service container operation claimed by a managed node. */
export interface ClaimedManagedSkillServiceOperation {
  operationId: string;
  workspaceId: string;
  runtimeId: string;
  serviceId: string;
  installationId?: string;
  operation: "provision" | "retire";
  status: string;
  catalog: {
    imageDigest: string;
    protocol: string;
    networkJson?: string;
    healthJson?: string;
    resourcesJson?: string;
    /** Container hardening declared by the admitted catalog template. */
    runAsNonRoot: boolean;
    readOnlyRootfs: boolean;
    capDrop: string[];
  };
}

export interface ClaimManagedSkillServiceOperationResponse {
  operation: ClaimedManagedSkillServiceOperation | null;
}

export interface CompleteManagedSkillServiceOperationRequest {
  endpointRef?: string;
  healthRevision?: string;
  safeResultJson?: string;
}

export interface FailManagedSkillServiceOperationRequest {
  errorCode: string;
  errorMessage: string;
  safeResultJson?: string;
}

export interface StartRuntimeAppOperationRequest {
  status?: "running";
}

export interface CompleteRuntimeAppOperationRequest {
  safeStdoutTail?: string;
  safeStderrTail?: string;
  installedApp?: {
    displayName: string;
    version?: string;
    entryPoint?: string;
    installStrategy?: RuntimeAppInstallStrategy;
    metadataJson?: string;
  };
}

export interface FailRuntimeAppOperationRequest {
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage: string;
}

/* ------------------------------------------------------------------ */
/* MCP center — daemon operation contract + runtime bridge abstraction  */
/* ------------------------------------------------------------------ */

export type McpConnectionOperationType = "verify" | "enable" | "disable" | "remove";
export type McpConnectionOperationSource = "user_verify" | "config_change" | "secret_rotation" | "health_check" | "enable" | "remove";
export type McpConnectionOperationStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type McpConnectionStatus =
  | "pending_configuration"
  | "queued_verification"
  | "verifying"
  | "ready"
  | "degraded"
  | "failed"
  | "disabled";
export type McpTransport = "streamable_http" | "sse" | "managed_service" | "managed_stdio";
export type McpVerificationOutcome = "ready" | "failed" | "degraded";
export type McpErrorCode =
  | "mcp.policy_denied"
  | "mcp.network_unreachable"
  | "mcp.authentication_failed"
  | "mcp.protocol_invalid"
  | "mcp.timeout"
  | "mcp.tool_not_approved"
  | "mcp.approved_tool_missing";

/** A discovered tool's metadata. The input schema is persisted (secret-like example values are redacted by the daemon before this is stored) so the provider bridge can expose a native tool definition. */
export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  inputSchemaDigest: string;
}

/** Result returned by the daemon after a `verify` operation (initialize + tools/list). */
export interface McpVerificationResult {
  status: McpVerificationOutcome;
  protocolVersion?: string;
  discoveredTools?: McpDiscoveredTool[];
  toolsFingerprint?: string;
  latencyMs?: number;
  error?: { code: McpErrorCode; safeMessage: string };
}

/**
 * Non-secret MCP tool manifest eligible for task-context injection.
 *
 * This contract intentionally carries no endpoint, request configuration, or
 * credential material. A future Runtime gateway must resolve those values in
 * its own protected process, never from a Provider-visible task bundle.
 */
export interface RuntimeMcpConnectionContextEntry {
  connectionId: string;
  catalogItemSlug: string;
  displayName: string;
  transport: McpTransport;
  approvedTools: string[];
  /** Approved ∩ discovered tools, each carrying its real input schema for a future gateway. */
  tools: RuntimeMcpTool[];
}

/** A single MCP tool exposed to the provider bridge. Stable id: `mcp:<connectionId>:<toolName>`. */
export interface RuntimeMcpTool {
  id: `mcp:${string}:${string}`;
  connectionId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Connection with enough resolved, in-memory state for the daemon client to call the remote server. */
export interface ResolvedMcpConnection {
  connectionId: string;
  runtimeId: string;
  workspaceId: string;
  transport: McpTransport;
  endpoint: string;
  allowedHosts: string[];
  approvedTools: string[];
  /** Decrypted header / OAuth / env values keyed by secret field name. Held in-process only. */
  secrets: Record<string, string>;
  nonSecretParams: Record<string, unknown>;
}

/** Protocol-agnostic MCP client used by the verify executor and future protected gateway. */
export interface RuntimeMcpClient {
  verify(connection: ResolvedMcpConnection): Promise<McpVerificationResult>;
  call(input: {
    connection: ResolvedMcpConnection;
    toolName: string;
    arguments: unknown;
    taskId: string;
  }): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: McpErrorCode; safeMessage: string } }>;
}

/** Claim shape delivered to the daemon for a connection operation. */
export interface ClaimedMcpConnectionOperation {
  id: string;
  workspaceId: string;
  runtimeId: string;
  connectionId: string;
  operation: McpConnectionOperationType;
  source: McpConnectionOperationSource;
  status: McpConnectionOperationStatus;
  transport: McpTransport;
  endpoint: string;
  allowedHosts: string[];
  approvedTools: string[];
  declaredTools: string[];
  /** Plaintext is delivered only in this one-time, authenticated daemon claim response. */
  secrets: Record<string, string>;
  nonSecretParams: Record<string, unknown>;
  createdAt: string;
}

export interface ClaimMcpConnectionOperationResponse {
  operation: ClaimedMcpConnectionOperation | null;
}

export interface StartMcpConnectionOperationRequest {
  status?: "running";
}

export interface CompleteMcpConnectionOperationRequest {
  safeStdoutTail?: string;
  safeStderrTail?: string;
  verification?: McpVerificationResult;
}

export interface FailMcpConnectionOperationRequest {
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: McpErrorCode;
  errorMessage: string;
  /** When present, overrides the control-plane default connection status on failure. */
  connectionStatus?: McpConnectionStatus;
}

/**
 * A resolved, one-time connection bundle for a running task's MCP session.
 *
 * Delivered ONLY through the authenticated daemon task-session claim response
 * and held in daemon memory for the loopback gateway. The Provider-visible task
 * bundle carries no endpoint, configuration, or credential material.
 */
export interface McpTaskSessionConnection {
  connectionId: string;
  workspaceId: string;
  catalogItemSlug: string;
  displayName: string;
  transport: McpTransport;
  endpoint: string;
  allowedHosts: string[];
  approvedTools: string[];
  nonSecretParams: Record<string, unknown>;
  /** Plaintext, daemon-only. The gateway writes these into memory, never into a Provider-readable file. */
  secrets: Record<string, string>;
  /** Approved ∩ discovered tools with their real input schemas. */
  tools: RuntimeMcpTool[];
}

export interface ClaimMcpTaskSessionResponse {
  /** Empty when the task has no eligible ready MCP connections. */
  connections: McpTaskSessionConnection[];
}

/** Per-call validation request sent by the daemon gateway before executing a tool. */
export interface ValidateMcpConnectionForTaskRequest {
  toolName: string;
}

/** Per-call validation response. `ok: true` means the connection is still ready and the tool is approved/discovered. */
export interface ValidateMcpConnectionForTaskResponse {
  ok: boolean;
  approvedTools?: string[];
  reason?: string;
}

/** Redacted tool-call audit reported by the daemon gateway; no raw arguments or outputs. */
export interface McpToolAuditReport {
  connectionId: string;
  taskId: string;
  toolName: string;
  outcome: "succeeded" | "failed";
  latencyMs?: number;
  safeSummary?: string;
  /** Client-generated idempotency key; a re-sent event_id is deduped server-side. */
  eventId: string;
}

export interface DaemonTaskOutputBundle {
  version: 1;
  format: "json-inline-v1";
  files: DaemonBundleFile[];
  /**
   * Changed files from the employee's real workDir (repository/state/artifacts),
   * diffed against the head-revision manifest. Empty/omitted when the task
   * produced no durable workdir changes.
   */
  workspaceFiles?: DaemonBundleFile[];
  /**
   * Captured paths present in the head manifest that no longer exist under the
   * workDir (provider deleted them). The promoted revision drops these.
   */
  deletedPaths?: string[];
}

export interface DaemonTaskUsage {
  modelId: string;
  runtimeCredentialId: string;
  routerSessionId?: string;
  gatewayRequestId?: string;
  gatewayUsageId?: string;
  protocol?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  requestStartedAt?: string;
  requestEndedAt?: string;
}

export interface CompleteTaskRequest {
  outputText?: string;
  sessionId?: string;
  routerSessionId?: string;
  workDir?: string;
  outputBundle?: DaemonTaskOutputBundle;
  usage?: DaemonTaskUsage;
  usages?: DaemonTaskUsage[];
}

export interface RuntimeApprovalRequest {
  approvalId: string;
  status: "pending" | "approved" | "rejected";
  reviewerComment?: string;
}

export interface CreateRuntimeApprovalRequest {
  provider: DaemonProvider;
  runtimeId: string;
  sessionId?: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  contentPreview: string;
}

export interface CreateRuntimeApprovalResponse {
  approval: RuntimeApprovalRequest;
}

export interface GetRuntimeApprovalResponse {
  approval: RuntimeApprovalRequest;
}
