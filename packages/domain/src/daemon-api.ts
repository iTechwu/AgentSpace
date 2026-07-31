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
}

export interface ClaimTaskResponse {
  task: ClaimedDaemonTask | null;
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
      source: "session_override" | "employee_default" | "runtime_default" | "team_policy_default" | "protocol_fallback";
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

export interface DaemonTaskOutputBundle {
  version: 1;
  format: "json-inline-v1";
  files: DaemonBundleFile[];
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
