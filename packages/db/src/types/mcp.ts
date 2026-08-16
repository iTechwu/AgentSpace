// MCP 中心目录与运行时连接（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。
import {
  type RuntimeAppCatalogSource,
} from "./runtime-apps.ts";

export type McpTransport = "streamable_http" | "sse" | "managed_service" | "managed_stdio";
export type McpRisk = "low" | "medium" | "high";
export type McpCatalogSource = "official" | "verified_partner" | "workspace_private";
export type McpConnectionStatus =
  | "pending_configuration"
  | "queued_verification"
  | "verifying"
  | "ready"
  | "degraded"
  | "failed"
  | "disabled";
export type McpConnectionOperationType = "verify" | "enable" | "disable" | "remove";
export type McpConnectionOperationStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type McpConnectionOperationStage = "queued" | "connecting" | "negotiating" | "discovering_tools" | "finalizing" | "completed";
export type McpConnectionOperationSource = "user_verify" | "config_change" | "secret_rotation" | "health_check" | "enable" | "remove";
export type McpToolCallOutcome = "succeeded" | "failed";
export type McpCatalogCategory =
  | "developer_tools"
  | "productivity"
  | "data_analytics"
  | "communication"
  | "knowledge"
  | "automation"
  | "other";
export type McpErrorCode =
  | "mcp.policy_denied"
  | "mcp.network_unreachable"
  | "mcp.authentication_failed"
  | "mcp.protocol_invalid"
  | "mcp.timeout"
  | "mcp.tool_not_approved"
  | "mcp.approved_tool_missing";

export interface McpCatalogItemRecord {
  id: string;
  workspaceId: string;
  source: McpCatalogSource;
  slug: string;
  version: string;
  category: McpCatalogCategory;
  transport: McpTransport;
  displayName: string;
  description: string;
  allowedHostsJson: string;
  configurationSchemaJson: string;
  declaredToolsJson: string;
  defaultApprovedToolsJson: string;
  secretFieldsJson: string;
  requiredRuntimeCapabilitiesJson: string;
  dataDomainsJson: string;
  risk: McpRisk;
  endpointTemplate?: string;
  documentationUrl?: string;
  requiredRuntimeApp?: {
    source: RuntimeAppCatalogSource;
    name: string;
    version: string;
  };
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeMcpConnectionRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  catalogItemId: string;
  status: McpConnectionStatus;
  approvedToolsJson: string;
  endpoint: string;
  nonSecretParamsJson: string;
  endpointFingerprint?: string;
  lastVerifiedAt?: string;
  nextHealthCheckAt?: string;
  healthCheckConsecutiveFailures: number;
  lastStatus?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeMcpSecretRecord {
  connectionId: string;
  fieldName: string;
  encryptedValue: string;
  keyVersion: string;
  rotatedAt: string;
  rotatedByUserId?: string;
}

export interface RuntimeMcpDiscoverySnapshotRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  protocolVersion?: string;
  toolsMetadataJson: string;
  toolsFingerprint: string;
  discoveredAt: string;
  verificationLatencyMs?: number;
}

export interface RuntimeMcpOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  connectionId: string;
  operation: McpConnectionOperationType;
  source: McpConnectionOperationSource;
  status: McpConnectionOperationStatus;
  stage: McpConnectionOperationStage;
  failedStage?: McpConnectionOperationStage;
  stageUpdatedAt: string;
  requestSnapshotJson: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage?: string;
  requestedByUserId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RuntimeMcpToolAuditRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  taskId?: string;
  toolName: string;
  outcome: McpToolCallOutcome;
  latencyMs?: number;
  safeSummary?: string;
  /** Client-generated idempotency key (unique per workspace). */
  eventId?: string;
  /** Immutable execution identity copied from the authenticated task. */
  actorType?: "agent";
  actorId?: string;
  runtimeId?: string;
  createdAt: string;
}
