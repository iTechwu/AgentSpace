// mcp-center 私有共享层（3.2-4 拆分自 mcp-center.ts）：SELECT 列片段 / 行映射 / 类型守卫 / 工具函数。
import type {
  McpCatalogItemRecord,
  McpCatalogCategory,
  McpCatalogSource,
  McpConnectionOperationSource,
  McpConnectionOperationStage,
  McpConnectionOperationStatus,
  McpConnectionOperationType,
  McpConnectionStatus,
  McpRisk,
  McpToolCallOutcome,
  McpTransport,
  RuntimeAppCatalogSource,
  RuntimeMcpConnectionRecord,
  RuntimeMcpDiscoverySnapshotRecord,
  RuntimeMcpOperationRecord,
  RuntimeMcpSecretRecord,
  RuntimeMcpToolAuditRecord,
} from "../types.ts";

export const MCP_CATALOG_ITEM_FIELDS = `
  id, workspace_id AS "workspaceId", source, slug, version, category, transport,
  display_name AS "displayName", description,
  allowed_hosts_json AS "allowedHostsJson",
  configuration_schema_json AS "configurationSchemaJson",
  declared_tools_json AS "declaredToolsJson",
  default_approved_tools_json AS "defaultApprovedToolsJson",
  secret_fields_json AS "secretFieldsJson",
  required_runtime_capabilities_json AS "requiredRuntimeCapabilitiesJson",
  data_domains_json AS "dataDomainsJson",
  risk, endpoint_template AS "endpointTemplate", documentation_url AS "documentationUrl",
  required_runtime_app_json AS "requiredRuntimeAppJson",
  synced_at AS "syncedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
export const MCP_CATALOG_ITEM_COLUMNS = `SELECT ${MCP_CATALOG_ITEM_FIELDS}`;

export const MCP_CONNECTION_COLUMNS = `SELECT
  id, workspace_id AS "workspaceId", runtime_id AS "runtimeId", catalog_item_id AS "catalogItemId",
  status, approved_tools_json AS "approvedToolsJson", endpoint,
  non_secret_params_json AS "nonSecretParamsJson", endpoint_fingerprint AS "endpointFingerprint",
  last_verified_at AS "lastVerifiedAt", next_health_check_at AS "nextHealthCheckAt",
  health_check_consecutive_failures AS "healthCheckConsecutiveFailures",
  last_status AS "lastStatus", last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage",
  created_by_user_id AS "createdByUserId", created_at AS "createdAt", updated_at AS "updatedAt"`;

export const MCP_DISCOVERY_COLUMNS = `SELECT
  id, workspace_id AS "workspaceId", connection_id AS "connectionId",
  protocol_version AS "protocolVersion", tools_metadata_json AS "toolsMetadataJson",
  tools_fingerprint AS "toolsFingerprint", discovered_at AS "discoveredAt",
  verification_latency_ms AS "verificationLatencyMs"`;

export const MCP_OPERATION_COLUMNS = `SELECT
  id, workspace_id AS "workspaceId", runtime_id AS "runtimeId", connection_id AS "connectionId",
  operation, source, status, stage, failed_stage AS "failedStage", stage_updated_at AS "stageUpdatedAt",
  request_snapshot_json AS "requestSnapshotJson",
  safe_stdout_tail AS "safeStdoutTail", safe_stderr_tail AS "safeStderrTail",
  error_code AS "errorCode", error_message AS "errorMessage",
  requested_by_user_id AS "requestedByUserId",
  created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt"`;

export const MCP_TOOL_AUDIT_COLUMNS = `SELECT
  id, workspace_id AS "workspaceId", connection_id AS "connectionId", task_id AS "taskId",
  tool_name AS "toolName", outcome, latency_ms AS "latencyMs", safe_summary AS "safeSummary",
  event_id AS "eventId",
  (SELECT data_json ->> 'actorType' FROM audit_log WHERE code = 'mcp_tool.call' AND data_json ->> 'mcpToolAuditId' = runtime_mcp_tool_audit.id LIMIT 1) AS "actorType",
  (SELECT data_json ->> 'actorId' FROM audit_log WHERE code = 'mcp_tool.call' AND data_json ->> 'mcpToolAuditId' = runtime_mcp_tool_audit.id LIMIT 1) AS "actorId",
  (SELECT data_json ->> 'runtimeId' FROM audit_log WHERE code = 'mcp_tool.call' AND data_json ->> 'mcpToolAuditId' = runtime_mcp_tool_audit.id LIMIT 1) AS "runtimeId",
  created_at AS "createdAt"`;

export function mapMcpCatalogItemRecord(value: Record<string, unknown>): McpCatalogItemRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !isMcpCatalogSource(value.source) ||
    typeof value.slug !== "string" ||
    typeof value.version !== "string" ||
    !isMcpCatalogCategory(value.category) ||
    !isMcpTransport(value.transport) ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.allowedHostsJson !== "string" ||
    typeof value.configurationSchemaJson !== "string" ||
    typeof value.declaredToolsJson !== "string" ||
    typeof value.defaultApprovedToolsJson !== "string" ||
    typeof value.secretFieldsJson !== "string" ||
    typeof value.requiredRuntimeCapabilitiesJson !== "string" ||
    typeof value.dataDomainsJson !== "string" ||
    !isMcpRisk(value.risk) ||
    typeof value.syncedAt !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    source: value.source,
    slug: value.slug,
    version: value.version,
    category: value.category,
    transport: value.transport,
    displayName: value.displayName,
    description: value.description,
    allowedHostsJson: value.allowedHostsJson,
    configurationSchemaJson: value.configurationSchemaJson,
    declaredToolsJson: value.declaredToolsJson,
    defaultApprovedToolsJson: value.defaultApprovedToolsJson,
    secretFieldsJson: value.secretFieldsJson,
    requiredRuntimeCapabilitiesJson: value.requiredRuntimeCapabilitiesJson,
    dataDomainsJson: value.dataDomainsJson,
    risk: value.risk,
    endpointTemplate: readOptionalString(value.endpointTemplate),
    documentationUrl: readOptionalString(value.documentationUrl),
    requiredRuntimeApp: parseRequiredRuntimeApp(value.requiredRuntimeAppJson ?? value.requiredruntimeappjson),
    syncedAt: value.syncedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function isMcpCatalogCategory(value: unknown): value is McpCatalogCategory {
  return [
    "developer_tools",
    "productivity",
    "data_analytics",
    "communication",
    "knowledge",
    "automation",
    "other",
  ].includes(String(value));
}

export function mapRuntimeMcpConnectionRecord(value: Record<string, unknown>): RuntimeMcpConnectionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.catalogItemId !== "string" ||
    !isMcpConnectionStatus(value.status) ||
    typeof value.approvedToolsJson !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.nonSecretParamsJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.healthCheckConsecutiveFailures !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    catalogItemId: value.catalogItemId,
    status: value.status,
    approvedToolsJson: value.approvedToolsJson,
    endpoint: value.endpoint,
    nonSecretParamsJson: value.nonSecretParamsJson,
    endpointFingerprint: readOptionalString(value.endpointFingerprint),
    lastVerifiedAt: readOptionalString(value.lastVerifiedAt),
    nextHealthCheckAt: readOptionalString(value.nextHealthCheckAt),
    healthCheckConsecutiveFailures: value.healthCheckConsecutiveFailures,
    lastStatus: readOptionalString(value.lastStatus),
    lastErrorCode: readOptionalString(value.lastErrorCode),
    lastErrorMessage: readOptionalString(value.lastErrorMessage),
    createdByUserId: readOptionalString(value.createdByUserId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function mapRuntimeMcpSecretRecord(value: Record<string, unknown>): RuntimeMcpSecretRecord | null {
  if (
    typeof value.connectionId !== "string" ||
    typeof value.fieldName !== "string" ||
    typeof value.encryptedValue !== "string" ||
    typeof value.keyVersion !== "string" ||
    typeof value.rotatedAt !== "string"
  ) {
    return null;
  }
  return {
    connectionId: value.connectionId,
    fieldName: value.fieldName,
    encryptedValue: value.encryptedValue,
    keyVersion: value.keyVersion,
    rotatedAt: value.rotatedAt,
    rotatedByUserId: readOptionalString(value.rotatedByUserId),
  };
}

export function mapRuntimeMcpDiscoverySnapshotRecord(value: Record<string, unknown>): RuntimeMcpDiscoverySnapshotRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.toolsMetadataJson !== "string" ||
    typeof value.toolsFingerprint !== "string" ||
    typeof value.discoveredAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    connectionId: value.connectionId,
    protocolVersion: readOptionalString(value.protocolVersion),
    toolsMetadataJson: value.toolsMetadataJson,
    toolsFingerprint: value.toolsFingerprint,
    discoveredAt: value.discoveredAt,
    verificationLatencyMs: typeof value.verificationLatencyMs === "number" ? value.verificationLatencyMs : undefined,
  };
}

export function mapRuntimeMcpOperationRecord(value: Record<string, unknown>): RuntimeMcpOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.connectionId !== "string" ||
    !isMcpConnectionOperationType(value.operation) ||
    !isMcpConnectionOperationSource(value.source) ||
    !isMcpConnectionOperationStatus(value.status) ||
    typeof value.requestSnapshotJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    connectionId: value.connectionId,
    operation: value.operation,
    source: value.source,
    status: value.status,
    stage: isMcpConnectionOperationStage(value.stage) ? value.stage : "queued",
    failedStage: isMcpConnectionOperationStage(value.failedStage) ? value.failedStage : undefined,
    stageUpdatedAt: readOptionalString(value.stageUpdatedAt) ?? value.createdAt,
    requestSnapshotJson: value.requestSnapshotJson,
    safeStdoutTail: readOptionalString(value.safeStdoutTail),
    safeStderrTail: readOptionalString(value.safeStderrTail),
    errorCode: readOptionalString(value.errorCode),
    errorMessage: readOptionalString(value.errorMessage),
    requestedByUserId: readOptionalString(value.requestedByUserId),
    createdAt: value.createdAt,
    startedAt: readOptionalString(value.startedAt),
    completedAt: readOptionalString(value.completedAt),
  };
}

export function mapRuntimeMcpToolAuditRecord(value: Record<string, unknown>): RuntimeMcpToolAuditRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.toolName !== "string" ||
    !isMcpToolCallOutcome(value.outcome) ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    connectionId: value.connectionId,
    taskId: readOptionalString(value.taskId),
    toolName: value.toolName,
    outcome: value.outcome,
    latencyMs: typeof value.latencyMs === "number" ? value.latencyMs : undefined,
    safeSummary: readOptionalString(value.safeSummary),
    eventId: readOptionalString(value.eventId),
    actorType: value.actorType === "agent" ? "agent" : undefined,
    actorId: readOptionalString(value.actorId),
    runtimeId: readOptionalString(value.runtimeId),
    createdAt: value.createdAt,
  };
}

export function isMcpTransport(value: unknown): value is McpTransport {
  return value === "streamable_http" || value === "sse" || value === "managed_service" || value === "managed_stdio";
}
export function isMcpRisk(value: unknown): value is McpRisk {
  return value === "low" || value === "medium" || value === "high";
}
export function isMcpCatalogSource(value: unknown): value is McpCatalogSource {
  return value === "official" || value === "verified_partner" || value === "workspace_private";
}
export function parseRequiredRuntimeApp(value: unknown): McpCatalogItemRecord["requiredRuntimeApp"] {
  if (value === null || value === undefined || value === "") return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const item = parsed as Record<string, unknown>;
  if (!isRuntimeAppCatalogSource(item.source) || typeof item.name !== "string" || !item.name.trim() || typeof item.version !== "string" || !item.version.trim()) {
    return undefined;
  }
  return { source: item.source, name: item.name.trim(), version: item.version.trim() };
}
export function isRuntimeAppCatalogSource(value: unknown): value is RuntimeAppCatalogSource {
  return value === "clihub_harness" || value === "clihub_public" || value === "skill_dependency" || value === "workspace_private";
}
export function isMcpConnectionStatus(value: unknown): value is McpConnectionStatus {
  return (
    value === "pending_configuration" ||
    value === "queued_verification" ||
    value === "verifying" ||
    value === "ready" ||
    value === "degraded" ||
    value === "failed" ||
    value === "disabled"
  );
}
export function isMcpConnectionOperationType(value: unknown): value is McpConnectionOperationType {
  return value === "verify" || value === "enable" || value === "disable" || value === "remove";
}
export function isMcpConnectionOperationStatus(value: unknown): value is McpConnectionOperationStatus {
  return value === "pending" || value === "claimed" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}
export function isMcpConnectionOperationStage(value: unknown): value is McpConnectionOperationStage {
  return value === "queued" || value === "connecting" || value === "negotiating" || value === "discovering_tools" || value === "finalizing" || value === "completed";
}
export function isMcpConnectionOperationSource(value: unknown): value is McpConnectionOperationSource {
  return value === "user_verify" || value === "config_change" || value === "secret_rotation" || value === "health_check" || value === "enable" || value === "remove";
}
export function isMcpToolCallOutcome(value: unknown): value is McpToolCallOutcome {
  return value === "succeeded" || value === "failed";
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function throwMissing(label: string): never {
  throw new Error(`Failed to persist MCP ${label}.`);
}
