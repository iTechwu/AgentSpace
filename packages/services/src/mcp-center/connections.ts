import {
  cancelUnfinishedMcpOperationsForConnectionSync,
  claimMcpTaskSessionMarkerSync,
  completeMcpOperationSync,
  createMcpConnectionSync,
  createMcpOperationSync,
  failMcpOperationSync,
  getDatabase,
  withTransaction,
  listMcpConnectionsForRuntimeSync,
  listMcpConnectionsSync,
  listMcpOperationsForConnectionSync,
  listMcpToolAuditsSync,
  readAgentRuntimeSync,
  readLatestMcpDiscoverySnapshotSync,
  readMcpCatalogItemSync,
  readMcpConnectionSecretsSync,
  readMcpConnectionSync,
  readMcpOperationSync,
  scheduleMcpHealthChecksSync as dbScheduleMcpHealthChecksSync,
  updateMcpConnectionConfigSync,
  updateMcpConnectionStatusSync,
  upsertMcpSecretsSync,
  type McpCatalogItemRecord,
  type McpConnectionOperationType,
  type RuntimeMcpConnectionRecord,
  type RuntimeMcpDiscoverySnapshotRecord,
  type RuntimeMcpOperationRecord,
  type RuntimeMcpSecretRecord,
  type RuntimeMcpToolAuditRecord,
} from "@dofe-agent/db";
import type {
  ClaimMcpTaskSessionResponse,
  ClaimedMcpConnectionOperation,
  McpConnectionOperationSource,
  McpConnectionStatus,
  McpDiscoveredTool,
  McpTaskSessionConnection,
  McpVerificationOutcome,
  McpVerificationResult,
  RuntimeMcpConnectionContextEntry,
  RuntimeMcpTool,
} from "@dofe-agent/domain";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { assertCanManageMcpCenterSync, type McpDeclaredTool } from "./catalog.ts";
import {
  decryptMcpSecret,
  encryptMcpSecret,
  validateMcpConnectionConfiguration,
  redactToolInputSchema,
  validateMcpEndpoint,
  validateMcpRequestHeaders,
} from "./security.ts";

/* ------------------------------------------------------------------ */
/* Request a new connection (create + queue verify)                    */
/* ------------------------------------------------------------------ */

export interface RequestMcpConnectionInput {
  workspaceId: string;
  actorUserId?: string;
  runtimeId: string;
  catalogItemId: string;
  endpoint: string;
  nonSecretParams?: Record<string, unknown>;
  secrets?: Record<string, string>;
  approvedTools?: string[];
  confirmHighRisk?: boolean;
}

export interface RequestMcpConnectionResult {
  connection: RuntimeMcpConnectionRecord;
  operation: RuntimeMcpOperationRecord;
}

export function requestMcpConnectionSync(input: RequestMcpConnectionInput): RequestMcpConnectionResult {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });

  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== input.workspaceId) {
    throw new Error("runtime.not_found");
  }
  if (runtime.status !== "online") {
    throw new Error("runtime.offline");
  }

  const catalog = readMcpCatalogItemSync(input.catalogItemId, input.workspaceId);
  if (!catalog) {
    throw new Error("mcp_catalog.not_found");
  }
  if (catalog.transport !== "streamable_http") {
    throw new Error("mcp.unsupported_transport");
  }

  const allowedHosts = parseJsonArray(catalog.allowedHostsJson);
  const endpointCheck = validateMcpEndpoint(input.endpoint, allowedHosts);
  if (!endpointCheck.ok) {
    throw new Error(endpointCheck.code ?? "mcp.policy_denied");
  }
  const headerCheck = validateMcpRequestHeaders(input.nonSecretParams ?? {});
  if (!headerCheck.ok) {
    throw new Error(headerCheck.code ?? "mcp.policy_denied");
  }
  const configurationCheck = validateMcpConnectionConfiguration(parseJsonObject(catalog.configurationSchemaJson), input.nonSecretParams ?? {});
  if (!configurationCheck.ok) {
    throw new Error(configurationCheck.code ?? "mcp.policy_denied");
  }

  const declaredTools = parseDeclaredTools(catalog.declaredToolsJson);
  const declaredNames = new Set(declaredTools.map((t) => t.name));
  const secretFields = parseJsonArray(catalog.secretFieldsJson);

  const encryptedSecrets = resolveSecretsForCreate(secretFields, input.secrets ?? {});

  const approvedTools = computeApprovedTools(declaredTools, input.approvedTools ?? parseJsonArray(catalog.defaultApprovedToolsJson));
  if (approvedTools.some((name) => !declaredNames.has(name))) {
    throw new Error("mcp.tool_not_declared");
  }

  const requiresHighRiskConfirm = catalog.risk === "high" || approvedTools.some((name) => declaredTools.find((t) => t.name === name)?.risk === "high");
  if (requiresHighRiskConfirm && input.confirmHighRisk !== true) {
    throw new Error("mcp.high_risk_confirmation_required");
  }

  const connection = createMcpConnectionSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    catalogItemId: catalog.id,
    endpoint: input.endpoint,
    nonSecretParamsJson: JSON.stringify(input.nonSecretParams ?? {}),
    approvedToolsJson: JSON.stringify(approvedTools),
    createdByUserId: input.actorUserId,
  });

  if (Object.keys(encryptedSecrets).length > 0) {
    upsertMcpSecretsSync(
      Object.entries(encryptedSecrets).map(([fieldName, encryptedValue]) => ({
        connectionId: connection.id,
        fieldName,
        encryptedValue,
        keyVersion: "mcp1",
        rotatedByUserId: input.actorUserId,
      })),
    );
  }

  const operation = createMcpOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: runtime.id,
    connectionId: connection.id,
    operation: "verify",
    source: "user_verify",
    requestedByUserId: input.actorUserId,
    requestSnapshotJson: JSON.stringify({
      endpoint: endpointCheck.host ? `https://${endpointCheck.host}` : undefined,
      host: endpointCheck.host,
      transport: catalog.transport,
      approvedToolCount: approvedTools.length,
      risk: catalog.risk,
    }),
  });

  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP connection requested",
    note: `Connection to "${catalog.displayName}" requested for runtime "${runtime.name}".`,
    code: "mcp_connection.connect_requested",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "mcp_connection",
      resourceId: connection.id,
      runtimeId: runtime.id,
      catalogItemId: catalog.id,
      transport: catalog.transport,
      risk: catalog.risk,
      approvedToolCount: approvedTools.length,
    },
  });

  return { connection, operation };
}

/* ------------------------------------------------------------------ */
/* Lifecycle operations                                                */
/* ------------------------------------------------------------------ */

export function reverifyMcpConnectionSync(input: {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
}): RuntimeMcpOperationRecord {
  return createConnectionOperationSync({ ...input, operation: "verify" });
}

export function disableMcpConnectionSync(input: {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
}): RuntimeMcpConnectionRecord {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });
  const connection = requireConnection(input.connectionId, input.workspaceId);
  if (connection.status === "disabled") {
    return connection;
  }
  cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id, workspaceId: input.workspaceId });
  const updated = updateMcpConnectionStatusSync({
    connectionId: connection.id,
    workspaceId: input.workspaceId,
    status: "disabled",
    lastStatus: connection.status,
  });
  auditLifecycleEvent(input.workspaceId, connection, "disabled", input.actorUserId);
  return updated;
}

export function enableMcpConnectionSync(input: {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
}): RuntimeMcpOperationRecord {
  // Enabling a disabled connection re-verifies before tools are exposed again.
  return createConnectionOperationSync({ ...input, operation: "enable" });
}

export function removeMcpConnectionSync(input: {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
}): RuntimeMcpOperationRecord {
  return createConnectionOperationSync({ ...input, operation: "remove" });
}

function createConnectionOperationSync(input: {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
  operation: McpConnectionOperationType;
}): RuntimeMcpOperationRecord {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });
  const connection = requireConnection(input.connectionId, input.workspaceId);
  if (input.operation === "enable") {
    if (connection.status !== "disabled") {
      throw new Error("mcp.not_disabled");
    }
    updateMcpConnectionStatusSync({
      connectionId: connection.id,
      workspaceId: input.workspaceId,
      status: "queued_verification",
    });
  } else if (input.operation === "verify") {
    if (connection.status === "disabled") {
      throw new Error("mcp.connection_disabled");
    }
    cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id, workspaceId: input.workspaceId });
    updateMcpConnectionStatusSync({
      connectionId: connection.id,
      workspaceId: input.workspaceId,
      status: "queued_verification",
    });
  } else {
    cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id, workspaceId: input.workspaceId });
  }
  const operation = createMcpOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: connection.runtimeId,
    connectionId: connection.id,
    operation: input.operation,
    source: sourceForConnectionOperation(input.operation),
    requestedByUserId: input.actorUserId,
  });
  auditLifecycleEvent(input.workspaceId, connection, input.operation, input.actorUserId);
  return operation;
}

/* ------------------------------------------------------------------ */
/* Configuration + secret rotation                                     */
/* ------------------------------------------------------------------ */

export interface UpdateMcpConnectionConfigServiceInput {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
  endpoint?: string;
  nonSecretParams?: Record<string, unknown>;
  approvedTools?: string[];
  /** Required only when this update newly grants a high-risk tool. */
  confirmHighRisk?: boolean;
  /** When true, also (re)queue a verify operation after the config update. */
  queueVerification?: boolean;
}

export function updateMcpConnectionConfigServiceSync(input: UpdateMcpConnectionConfigServiceInput): {
  connection: RuntimeMcpConnectionRecord;
  operation?: RuntimeMcpOperationRecord;
} {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });
  const connection = requireConnection(input.connectionId, input.workspaceId);
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
  if (!catalog) {
    throw new Error("mcp_catalog.not_found");
  }
  if (input.endpoint !== undefined) {
    const check = validateMcpEndpoint(input.endpoint, parseJsonArray(catalog.allowedHostsJson));
    if (!check.ok) {
      throw new Error(check.code ?? "mcp.policy_denied");
    }
  }
  const mergedNonSecretParamsForUpdate = input.nonSecretParams === undefined
    ? undefined
    : { ...parseJsonObject(connection.nonSecretParamsJson), ...input.nonSecretParams };
  if (mergedNonSecretParamsForUpdate !== undefined) {
    const check = validateMcpRequestHeaders(mergedNonSecretParamsForUpdate);
    if (!check.ok) {
      throw new Error(check.code ?? "mcp.policy_denied");
    }
    const configurationCheck = validateMcpConnectionConfiguration(parseJsonObject(catalog.configurationSchemaJson), mergedNonSecretParamsForUpdate);
    if (!configurationCheck.ok) {
      throw new Error(configurationCheck.code ?? "mcp.policy_denied");
    }
  }
  if (input.approvedTools !== undefined) {
    const declaredTools = parseDeclaredTools(catalog.declaredToolsJson);
    const declared = new Map(declaredTools.map((tool) => [tool.name, tool]));
    if (input.approvedTools.some((name) => !declared.has(name))) {
      throw new Error("mcp.tool_not_declared");
    }
    const currentApproved = new Set(parseJsonArray(connection.approvedToolsJson));
    const addsHighRiskTool = input.approvedTools.some((name) =>
      !currentApproved.has(name) && declared.get(name)?.risk === "high",
    );
    if (addsHighRiskTool && input.confirmHighRisk !== true) {
      throw new Error("mcp.high_risk_confirmation_required");
    }
  }
  const reverifyAllowed = connection.status !== "disabled";
  cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id, workspaceId: input.workspaceId });
  let connection2 = updateMcpConnectionConfigSync({
    connectionId: connection.id,
    workspaceId: input.workspaceId,
    endpoint: input.endpoint,
    nonSecretParamsJson: mergedNonSecretParamsForUpdate === undefined ? undefined : JSON.stringify(mergedNonSecretParamsForUpdate),
    approvedToolsJson: input.approvedTools === undefined ? undefined : JSON.stringify(input.approvedTools),
  });
  let operation: RuntimeMcpOperationRecord | undefined;
  if (reverifyAllowed && input.queueVerification !== false) {
    operation = createMcpOperationSync({
      workspaceId: input.workspaceId,
      runtimeId: connection.runtimeId,
      connectionId: connection.id,
      operation: "verify",
      source: "config_change",
      requestedByUserId: input.actorUserId,
    });
  } else if (!reverifyAllowed) {
    connection2 = updateMcpConnectionStatusSync({
      connectionId: connection.id,
      workspaceId: input.workspaceId,
      status: "disabled",
      lastStatus: connection.lastStatus,
    });
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP connection configuration updated",
    note: `Configuration for connection "${catalog.displayName}" was updated; re-verification required.`,
    code: "mcp_connection.config_updated",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "mcp_connection",
      resourceId: connection.id,
    },
  });
  return { connection: connection2, operation };
}

export function rotateMcpSecretSync(input: {
  workspaceId: string;
  connectionId: string;
  fieldName: string;
  value: string;
  actorUserId?: string;
}): RuntimeMcpConnectionRecord {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });
  const connection = requireConnection(input.connectionId, input.workspaceId);
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
  if (!catalog) {
    throw new Error("mcp_catalog.not_found");
  }
  const secretFields = parseJsonArray(catalog.secretFieldsJson);
  if (!secretFields.includes(input.fieldName)) {
    throw new Error("mcp.unknown_secret_field");
  }
  const encrypted = encryptMcpSecret(input.value);
  upsertMcpSecretsSync([
    { connectionId: connection.id, fieldName: input.fieldName, encryptedValue: encrypted, keyVersion: "mcp1", rotatedByUserId: input.actorUserId },
  ]);
  // Any secret rotation invalidates readiness and fences the prior verification.
  cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id, workspaceId: input.workspaceId });
  let updated = updateMcpConnectionConfigSync({ connectionId: connection.id, workspaceId: input.workspaceId, approvedToolsJson: connection.approvedToolsJson });
  if (connection.status !== "disabled") {
    createMcpOperationSync({
      workspaceId: input.workspaceId,
      runtimeId: connection.runtimeId,
      connectionId: connection.id,
      operation: "verify",
      source: "secret_rotation",
      requestedByUserId: input.actorUserId,
    });
  } else {
    updated = updateMcpConnectionStatusSync({
      connectionId: connection.id,
      workspaceId: input.workspaceId,
      status: "disabled",
      lastStatus: connection.lastStatus,
    });
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP connection secret rotated",
    note: `Secret field "${input.fieldName}" was rotated for connection "${catalog.displayName}".`,
    code: "mcp_connection.secret_rotated",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "mcp_connection",
      resourceId: connection.id,
      secretField: input.fieldName,
    },
  });
  return updated;
}

export interface ReplaceMcpConnectionConfigServiceInput {
  workspaceId: string;
  connectionId: string;
  actorUserId?: string;
  endpoint?: string;
  nonSecretParams?: Record<string, unknown>;
  approvedTools?: string[];
  /** Plaintext secrets to rotate; fields not present keep their stored value. */
  secrets?: Record<string, string>;
  /** Required only when this update newly grants a high-risk tool. */
  confirmHighRisk?: boolean;
  /** When false, the connection is only written down (no verify op). */
  queueVerification?: boolean;
}

/**
 * Atomic replacement of a connection's non-secret configuration AND the given
 * secret fields in a single transaction, creating exactly one verify operation
 * and one audit event. Mirrors "完整替换配置" — fields not supplied stay
 * unchanged; a mid-flight failure rolls everything back instead of leaving a
 * partially-updated connection.
 */
export function replaceMcpConnectionConfigSync(input: ReplaceMcpConnectionConfigServiceInput): {
  connection: RuntimeMcpConnectionRecord;
  operation?: RuntimeMcpOperationRecord;
} {
  assertCanManageMcpCenterSync({ workspaceId: input.workspaceId, actorUserId: input.actorUserId });
  const connection = requireConnection(input.connectionId, input.workspaceId);
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
  if (!catalog) {
    throw new Error("mcp_catalog.not_found");
  }
  if (input.endpoint !== undefined) {
    const check = validateMcpEndpoint(input.endpoint, parseJsonArray(catalog.allowedHostsJson));
    if (!check.ok) {
      throw new Error(check.code ?? "mcp.policy_denied");
    }
  }
  // Client edits may send only the fields the user touched. Merge with the
  // stored configuration before validating and writing back, so untouched fields
  // are preserved instead of overwritten with empty values.
  const mergedNonSecretParams = input.nonSecretParams === undefined
    ? undefined
    : { ...parseJsonObject(connection.nonSecretParamsJson), ...input.nonSecretParams };
  if (mergedNonSecretParams !== undefined) {
    const headersCheck = validateMcpRequestHeaders(mergedNonSecretParams);
    if (!headersCheck.ok) {
      throw new Error(headersCheck.code ?? "mcp.policy_denied");
    }
    const configCheck = validateMcpConnectionConfiguration(parseJsonObject(catalog.configurationSchemaJson), mergedNonSecretParams);
    if (!configCheck.ok) {
      throw new Error(configCheck.code ?? "mcp.policy_denied");
    }
  }
  if (input.approvedTools !== undefined) {
    const declaredTools = parseDeclaredTools(catalog.declaredToolsJson);
    const declared = new Map(declaredTools.map((tool) => [tool.name, tool]));
    if (input.approvedTools.some((name) => !declared.has(name))) {
      throw new Error("mcp.tool_not_declared");
    }
    const currentApproved = new Set(parseJsonArray(connection.approvedToolsJson));
    const addsHighRiskTool = input.approvedTools.some((name) =>
      !currentApproved.has(name) && declared.get(name)?.risk === "high",
    );
    if (addsHighRiskTool && input.confirmHighRisk !== true) {
      throw new Error("mcp.high_risk_confirmation_required");
    }
  }
  const secretFields = new Set(parseJsonArray(catalog.secretFieldsJson));
  for (const fieldName of Object.keys(input.secrets ?? {})) {
    if (!secretFields.has(fieldName)) {
      throw new Error("mcp.unknown_secret_field");
    }
  }

  const reverifyAllowed = connection.status !== "disabled";
  const db = getDatabase();
  let updated: RuntimeMcpConnectionRecord | null = null;
  let operation: RuntimeMcpOperationRecord | undefined;
  withTransaction(db, () => {
    cancelUnfinishedMcpOperationsForConnectionSync({ connectionId: connection.id, workspaceId: input.workspaceId });
    updated = updateMcpConnectionConfigSync({
      connectionId: connection.id,
      workspaceId: input.workspaceId,
      endpoint: input.endpoint,
      nonSecretParamsJson: mergedNonSecretParams === undefined ? undefined : JSON.stringify(mergedNonSecretParams),
      approvedToolsJson: input.approvedTools === undefined ? undefined : JSON.stringify(input.approvedTools),
    });
    const rotations: Array<{ connectionId: string; fieldName: string; encryptedValue: string; keyVersion: string; rotatedByUserId?: string }> = [];
    for (const [fieldName, value] of Object.entries(input.secrets ?? {})) {
      if (value && value.trim()) {
        rotations.push({
          connectionId: connection.id,
          fieldName,
          encryptedValue: encryptMcpSecret(value),
          keyVersion: "mcp1",
          rotatedByUserId: input.actorUserId,
        });
      }
    }
    if (rotations.length > 0) {
      upsertMcpSecretsSync(rotations);
    }
    if (reverifyAllowed && input.queueVerification !== false) {
      operation = createMcpOperationSync({
        workspaceId: input.workspaceId,
        runtimeId: connection.runtimeId,
        connectionId: connection.id,
        operation: "verify",
        source: "config_change",
        requestedByUserId: input.actorUserId,
      });
    } else if (!reverifyAllowed) {
      updateMcpConnectionStatusSync({
        connectionId: connection.id,
        workspaceId: input.workspaceId,
        status: "disabled",
        lastStatus: connection.lastStatus,
      });
    }
  });
  if (!updated) {
    throw new Error("mcp.connection_not_found");
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP connection configuration replaced",
    note: `Configuration for connection "${catalog.displayName}" was replaced; re-verification required.`,
    code: "mcp_connection.config_replaced",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "mcp_connection",
      resourceId: connection.id,
      rotatedSecretCount: Object.keys(input.secrets ?? {}).filter((name) => input.secrets?.[name]?.trim()).length,
    },
  });
  return { connection: updated, operation };
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */

export interface McpSecretFieldStatus {
  fieldName: string;
  configured: boolean;
  rotatedAt?: string;
}

export interface McpConnectionDetail {
  connection: RuntimeMcpConnectionRecord;
  catalog: McpCatalogItemRecord;
  declaredTools: McpDeclaredTool[];
  approvedTools: string[];
  allowedHosts: string[];
  dataDomains: string[];
  secretFields: McpSecretFieldStatus[];
  snapshot?: RuntimeMcpDiscoverySnapshotRecord & { tools: McpDiscoveredTool[] };
}

export function readMcpConnectionDetailSync(input: {
  workspaceId: string;
  connectionId: string;
}): McpConnectionDetail | null {
  const connection = readMcpConnectionSync(input.connectionId, input.workspaceId);
  if (!connection) {
    return null;
  }
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
  if (!catalog) {
    return null;
  }
  const secrets = readMcpConnectionSecretsSync(connection.id, input.workspaceId);
  const secretByName = new Map(secrets.map((s) => [s.fieldName, s]));
  const snapshotRecord = readLatestMcpDiscoverySnapshotSync(connection.id, input.workspaceId);
  return {
    connection,
    catalog,
    declaredTools: parseDeclaredTools(catalog.declaredToolsJson),
    approvedTools: parseJsonArray(connection.approvedToolsJson),
    allowedHosts: parseJsonArray(catalog.allowedHostsJson),
    dataDomains: parseJsonArray(catalog.dataDomainsJson),
    secretFields: parseJsonArray(catalog.secretFieldsJson).map((fieldName) => {
      const stored = secretByName.get(fieldName);
      return { fieldName, configured: Boolean(stored), rotatedAt: stored?.rotatedAt };
    }),
    snapshot: snapshotRecord
      ? { ...snapshotRecord, tools: parseDiscoveredTools(snapshotRecord.toolsMetadataJson) }
      : undefined,
  };
}

export interface McpConnectionActivity {
  operations: RuntimeMcpOperationRecord[];
  audits: RuntimeMcpToolAuditRecord[];
}

interface ClaimedMcpTaskSessionCacheEntry {
  attemptId: string;
  result: ClaimMcpTaskSessionResponse;
}

/**
 * In-process replay cache for one-time MCP task-session claims. Lets an HTTP
 * retry of the same attempt return the original resolved bundle instead of an
 * empty (degraded) authorization. See {@link claimMcpTaskSessionSync}.
 */
const claimedMcpTaskSessionCache = new Map<string, ClaimedMcpTaskSessionCacheEntry>();

export function listMcpConnectionActivitySync(input: {
  workspaceId: string;
  connectionId: string;
  limit?: number;
}): McpConnectionActivity {
  return {
    operations: listMcpOperationsForConnectionSync(input.connectionId, input.workspaceId, input.limit ?? 25),
    audits: listMcpToolAuditsSync({ workspaceId: input.workspaceId, connectionId: input.connectionId, limit: input.limit ?? 25 }),
  };
}

const MCP_HEALTH_CHECK_BASE_INTERVAL_MS = 60 * 60 * 1000;
const MCP_HEALTH_CHECK_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Schedules periodic health-check verify operations for due ready connections. */
export function scheduleMcpHealthChecksSync(input: {
  workspaceId?: string;
  runtimeId?: string;
  now?: string;
} = {}): number {
  return dbScheduleMcpHealthChecksSync(input);
}

/** Computes the next health-check timestamp after a verification result. */
export function computeMcpConnectionNextHealthCheckAt(input: {
  connection: RuntimeMcpConnectionRecord;
  now?: string;
  verificationStatus?: McpConnectionStatus;
}): string {
  const now = input.now ?? new Date().toISOString();
  if (input.verificationStatus === "failed" || input.verificationStatus === "degraded") {
    const failures = input.connection.healthCheckConsecutiveFailures;
    const backoffMs = Math.min(
      MCP_HEALTH_CHECK_BASE_INTERVAL_MS * 2 ** failures,
      MCP_HEALTH_CHECK_MAX_INTERVAL_MS,
    );
    return new Date(new Date(now).getTime() + backoffMs).toISOString();
  }
  return new Date(new Date(now).getTime() + MCP_HEALTH_CHECK_BASE_INTERVAL_MS).toISOString();
}

/** Complete wrapper that also advances the connection's health-check schedule. */
export function completeMcpConnectionOperationWithHealthScheduleSync(input: {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  verification?: {
    status: McpConnectionStatus;
    protocolVersion?: string;
    toolsMetadataJson: string;
    toolsFingerprint: string;
    latencyMs?: number;
    discoveredAt?: string;
    errorCode?: string;
    errorMessage?: string;
  };
}): RuntimeMcpOperationRecord {
  const operation = readMcpOperationSync(input.operationId, input.workspaceId);
  const connection = operation ? readMcpConnectionSync(operation.connectionId, operation.workspaceId) : null;
  const verificationStatus = input.verification?.status;
  const nextHealthCheckAt = connection &&
    (verificationStatus === "ready" || verificationStatus === "degraded" || verificationStatus === "failed")
    ? computeMcpConnectionNextHealthCheckAt({ connection, verificationStatus })
    : undefined;
  return completeMcpOperationSync({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    safeStdoutTail: input.safeStdoutTail,
    safeStderrTail: input.safeStderrTail,
    nextHealthCheckAt,
    verification: input.verification
      ? { ...input.verification, errorCode: input.verification.errorCode as import("@dofe-agent/domain").McpErrorCode | undefined }
      : undefined,
  });
}

/** Fail wrapper that also advances the health-check schedule and increments failures. */
export function failMcpConnectionOperationWithHealthScheduleSync(input: {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage: string;
  connectionStatus?: McpConnectionStatus;
}): RuntimeMcpOperationRecord {
  const operation = readMcpOperationSync(input.operationId, input.workspaceId);
  const connection = operation ? readMcpConnectionSync(operation.connectionId, operation.workspaceId) : null;
  const nextHealthCheckAt = connection
    ? computeMcpConnectionNextHealthCheckAt({ connection, verificationStatus: "failed" })
    : undefined;
  const healthCheckConsecutiveFailures = connection && operation?.source === "health_check"
    ? connection.healthCheckConsecutiveFailures + 1
    : undefined;
  return failMcpOperationSync({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    safeStdoutTail: input.safeStdoutTail,
    safeStderrTail: input.safeStderrTail,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    connectionStatus: input.connectionStatus,
    nextHealthCheckAt,
    healthCheckConsecutiveFailures,
  });
}

export function listMcpConnectionsForRuntimeServiceSync(input: {
  workspaceId: string;
  runtimeId: string;
}): RuntimeMcpConnectionRecord[] {
  return listMcpConnectionsForRuntimeSync({ workspaceId: input.workspaceId, runtimeId: input.runtimeId });
}

/* ------------------------------------------------------------------ */
/* Claim resolution (daemon claim route) + task-context bridge         */
/* ------------------------------------------------------------------ */

export function resolveClaimedMcpOperationSync(input: {
  workspaceId: string;
  operation: RuntimeMcpOperationRecord;
}): ClaimedMcpConnectionOperation | null {
  const connection = readMcpConnectionSync(input.operation.connectionId, input.workspaceId);
  if (!connection) {
    return null;
  }
  if (input.operation.operation === "remove") {
    // Removal is a local control-plane operation. It must remain possible even
    // when an old catalog row or encrypted secret is no longer valid.
    return {
      id: input.operation.id,
      workspaceId: input.operation.workspaceId,
      runtimeId: input.operation.runtimeId,
      connectionId: input.operation.connectionId,
      operation: input.operation.operation,
      source: input.operation.source,
      status: input.operation.status,
      transport: "streamable_http",
      endpoint: "",
      allowedHosts: [],
      approvedTools: [],
      declaredTools: [],
      secrets: {},
      nonSecretParams: {},
      createdAt: input.operation.createdAt,
    };
  }
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, input.workspaceId);
  if (!catalog) {
    return null;
  }
  const allowedHosts = parseJsonArray(catalog.allowedHostsJson);
  const nonSecretParams = parseJsonObject(connection.nonSecretParamsJson);
  const endpointCheck = validateMcpEndpoint(connection.endpoint, allowedHosts);
  const headerCheck = validateMcpRequestHeaders(nonSecretParams);
  const configurationCheck = validateMcpConnectionConfiguration(parseJsonObject(catalog.configurationSchemaJson), nonSecretParams);
  const declaredTools = parseDeclaredTools(catalog.declaredToolsJson);
  const approvedTools = parseJsonArray(connection.approvedToolsJson);
  if (
    !endpointCheck.ok ||
    !headerCheck.ok ||
    !configurationCheck.ok ||
    approvedTools.some((name) => !declaredTools.some((tool) => tool.name === name))
  ) {
    // Connections can outlive a catalog policy change. Do not let a legacy row
    // bypass the checks normally performed when configuration is submitted.
    return null;
  }
  const secrets = resolveDaemonSecretBundle(readMcpConnectionSecretsSync(connection.id, input.workspaceId));
  if (!secrets) {
    return null;
  }
  return {
    id: input.operation.id,
    workspaceId: input.operation.workspaceId,
    runtimeId: input.operation.runtimeId,
    connectionId: input.operation.connectionId,
    operation: input.operation.operation,
    source: input.operation.source,
    status: input.operation.status,
    transport: catalog.transport,
    endpoint: connection.endpoint,
    allowedHosts,
    approvedTools,
    declaredTools: declaredTools.map((t) => t.name),
    secrets,
    nonSecretParams,
    createdAt: input.operation.createdAt,
  };
}

function resolveDaemonSecretBundle(secrets: RuntimeMcpSecretRecord[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  try {
    for (const secret of secrets) {
      result[secret.fieldName] = decryptMcpSecret(secret.encryptedValue);
    }
    return result;
  } catch {
    return null;
  }
}

interface ResolvedReadyMcpConnection {
  connectionId: string;
  catalog: McpCatalogItemRecord;
  fresh: RuntimeMcpConnectionRecord;
  approved: string[];
  tools: RuntimeMcpTool[];
}

/**
 * Shared readiness/freshness check used both for the non-secret task manifest
 * and for the daemon's one-time session claim.
 *
 * - Re-reads the CURRENT connection row to avoid acting on a stale cached read.
 * - Verifies the connection is still `ready`.
 * - Verifies every approved tool is still present in the latest discovery
 *   snapshot; if not, the connection is marked `degraded` and excluded.
 * - Builds the RuntimeMcpTool list (with redacted input schemas).
 */
function resolveReadyMcpConnectionForTask(input: {
  workspaceId: string;
  connection: RuntimeMcpConnectionRecord;
  markDegradedOnMissingTool: boolean;
}): ResolvedReadyMcpConnection | null {
  const { workspaceId, connection, markDegradedOnMissingTool } = input;
  const catalog = readMcpCatalogItemSync(connection.catalogItemId, workspaceId);
  if (!catalog) return null;

  // Freshness: re-check the CURRENT status row (not a stale cached read).
  const fresh = readMcpConnectionSync(connection.id, workspaceId);
  if (!fresh || fresh.status !== "ready") return null;

  const snapshot = readLatestMcpDiscoverySnapshotSync(connection.id, workspaceId);
  if (!snapshot) return null;

  const discovered = parseDiscoveredTools(snapshot.toolsMetadataJson);
  const discoveredByName = new Map(discovered.map((t) => [t.name, t]));
  const approved = parseJsonArray(fresh.approvedToolsJson);

  // Authorization: every approved tool must still be declared by the catalog.
  // A catalog downgrade that removes a previously-declared tool must not grant
  // that tool to running tasks.
  const declaredTools = parseDeclaredTools(catalog.declaredToolsJson);
  const declaredNames = new Set(declaredTools.map((t) => t.name));
  const approvedDeclared = approved.every((name) => declaredNames.has(name));
  if (!approvedDeclared) {
    if (markDegradedOnMissingTool) {
      updateMcpConnectionStatusSync({
        connectionId: connection.id,
        workspaceId,
        status: "degraded",
        lastErrorCode: "mcp.approved_tool_missing",
        lastErrorMessage: "An approved tool is no longer declared by the catalog; the connection was removed from this task.",
      });
    }
    return null;
  }

  // Freshness: an approved tool that vanished from discovery excludes the connection.
  const approvedPresent = approved.every((name) => discoveredByName.has(name));
  if (!approvedPresent) {
    if (markDegradedOnMissingTool) {
      updateMcpConnectionStatusSync({
        connectionId: connection.id,
        workspaceId,
        status: "degraded",
        lastErrorCode: "mcp.approved_tool_missing",
        lastErrorMessage: "An approved tool is no longer discoverable; the connection was removed from this task.",
      });
    }
    return null;
  }

  const tools: RuntimeMcpTool[] = [];
  for (const name of approved) {
    const tool = discoveredByName.get(name);
    if (!tool) continue;
    tools.push({
      id: `mcp:${connection.id}:${name}`,
      connectionId: connection.id,
      name,
      description: tool.description,
      inputSchema: redactToolInputSchema(tool.inputSchema),
    });
  }
  if (tools.length === 0) return null;

  return { connectionId: connection.id, catalog, fresh, approved, tools };
}

/**
 * Builds non-secret task manifests for `ready` connections.
 *
 * Endpoint and credential data deliberately stay outside this result: task
 * bundles can be visible to a Provider subprocess, while the future MCP
 * gateway must keep the resolved connection in a protected process.
 *
 * Performs the same freshness check as the daemon claim path: a connection
 * that is no longer `ready` or whose approved tools have disappeared from the
 * latest discovery snapshot is excluded from the manifest (and degraded).
 */
export function listReadyMcpConnectionsForTaskSync(input: {
  workspaceId: string;
  runtimeId: string;
}): RuntimeMcpConnectionContextEntry[] {
  const connections = listMcpConnectionsSync({ workspaceId: input.workspaceId, runtimeId: input.runtimeId, status: "ready", limit: 500 });
  const entries: RuntimeMcpConnectionContextEntry[] = [];
  for (const connection of connections) {
    const resolved = resolveReadyMcpConnectionForTask({
      workspaceId: input.workspaceId,
      connection,
      markDegradedOnMissingTool: true,
    });
    if (!resolved) continue;
    entries.push({
      connectionId: resolved.connectionId,
      catalogItemSlug: resolved.catalog.slug,
      displayName: resolved.catalog.displayName,
      transport: resolved.catalog.transport,
      approvedTools: resolved.approved,
      tools: resolved.tools,
    });
  }
  return entries;
}

/**
 * Claims a one-time resolved MCP connection bundle for a running task.
 *
 * Daemon-only. Re-confirms each connection is still `ready` and that every
 * approved tool is still present in the latest discovery snapshot (freshness
 * check), then decrypts the secret bundle. The result is delivered only to the
 * daemon's memory for the loopback gateway — never into the Provider-visible
 * task bundle.
 *
 * Claim semantics are one-time per task, keyed by an attempt id:
 * - first claim for the task → resolve bundles and cache them by attempt id;
 * - retry of the SAME attempt (HTTP retry after a lost response) → replay the
 *   cached first result, so a lost response never degrades the task to "no MCP";
 * - a DIFFERENT attempt id (a genuine duplicate execution) → empty connections,
 *   which is a refusal, not a legitimate-looking empty authorization.
 *
 * The cache is in-process memory: if the control plane restarts between a
 * successful claim and a retry, the retry degrades to empty rather than
 * pretending to be authorized.
 */
export function claimMcpTaskSessionSync(input: {
  workspaceId: string;
  runtimeId: string;
  taskId: string;
  attemptId: string;
}): ClaimMcpTaskSessionResponse {
  const newlyClaimed = claimMcpTaskSessionMarkerSync(input.taskId);
  if (newlyClaimed) {
    const result = resolveClaimedMcpTaskSessionResult({
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
    });
    claimedMcpTaskSessionCache.set(input.taskId, { attemptId: input.attemptId, result });
    return result;
  }
  const cached = claimedMcpTaskSessionCache.get(input.taskId);
  if (cached && cached.attemptId === input.attemptId) {
    return cached.result;
  }
  return { connections: [] };
}

function resolveClaimedMcpTaskSessionResult(input: {
  workspaceId: string;
  runtimeId: string;
}): ClaimMcpTaskSessionResponse {
  const connections = listMcpConnectionsSync({ workspaceId: input.workspaceId, runtimeId: input.runtimeId, status: "ready", limit: 500 });
  const result: McpTaskSessionConnection[] = [];
  for (const connection of connections) {
    const resolved = resolveReadyMcpConnectionForTask({
      workspaceId: input.workspaceId,
      connection,
      markDegradedOnMissingTool: true,
    });
    if (!resolved) continue;
    const secrets = resolveDaemonSecretBundle(readMcpConnectionSecretsSync(connection.id, input.workspaceId));
    if (secrets === null) continue;
    result.push({
      connectionId: resolved.connectionId,
      workspaceId: input.workspaceId,
      catalogItemSlug: resolved.catalog.slug,
      displayName: resolved.catalog.displayName,
      transport: resolved.catalog.transport,
      endpoint: resolved.fresh.endpoint,
      allowedHosts: parseJsonArray(resolved.catalog.allowedHostsJson),
      approvedTools: resolved.approved,
      nonSecretParams: parseJsonObject(resolved.fresh.nonSecretParamsJson),
      secrets,
      tools: resolved.tools,
    });
  }
  return { connections: result };
}

/**
 * Re-validates a single MCP connection right before a tool call in the gateway.
 *
 * Returns the current approved tool list if the connection is still `ready` and
 * the requested tool is still both approved and discoverable. Returns `null`
 * (without mutating state) if the connection was disabled, reconfigured, or the
 * tool is no longer available. This is the per-call fencing that stops an
 * already-running task session from calling a connection an administrator just
 * disabled or changed.
 */
export function validateMcpConnectionForGatewaySync(input: {
  workspaceId: string;
  connectionId: string;
  toolName: string;
}): { ok: true; approvedTools: string[] } | { ok: false } {
  const connection = readMcpConnectionSync(input.connectionId, input.workspaceId);
  if (!connection || connection.status !== "ready") {
    return { ok: false };
  }
  const approved = parseJsonArray(connection.approvedToolsJson);
  if (!approved.includes(input.toolName)) {
    return { ok: false };
  }
  const snapshot = readLatestMcpDiscoverySnapshotSync(connection.id, input.workspaceId);
  if (!snapshot) {
    return { ok: false };
  }
  const discovered = parseDiscoveredTools(snapshot.toolsMetadataJson);
  const discoveredNames = new Set(discovered.map((t) => t.name));
  if (!discoveredNames.has(input.toolName)) {
    return { ok: false };
  }
  return { ok: true, approvedTools: approved };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function requireConnection(connectionId: string, workspaceId: string): RuntimeMcpConnectionRecord {
  const connection = readMcpConnectionSync(connectionId, workspaceId);
  if (!connection) {
    throw new Error("mcp.connection_not_found");
  }
  return connection;
}

function computeApprovedTools(declared: McpDeclaredTool[], requested: string[]): string[] {
  const declaredNames = new Set(declared.map((t) => t.name));
  const ordered: string[] = [];
  for (const name of requested) {
    const trimmed = name.trim();
    if (trimmed && declaredNames.has(trimmed) && !ordered.includes(trimmed)) {
      ordered.push(trimmed);
    }
  }
  return ordered;
}

function resolveSecretsForCreate(secretFields: string[], provided: Record<string, string>): Record<string, string> {
  const encrypted: Record<string, string> = {};
  for (const fieldName of secretFields) {
    const value = provided[fieldName];
    if (!value || !value.trim()) {
      throw new Error(`mcp.missing_secret:${fieldName}`);
    }
    encrypted[fieldName] = encryptMcpSecret(value);
  }
  return encrypted;
}

function auditLifecycleEvent(
  workspaceId: string,
  connection: RuntimeMcpConnectionRecord,
  action: string,
  actorUserId?: string,
): void {
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: `MCP connection ${action}`,
    note: `Connection ${connection.id} was ${action}.`,
    code: `mcp_connection.${action}`,
    data: {
      actorType: "session_user",
      actorUserId,
      resourceType: "mcp_connection",
      resourceId: connection.id,
      runtimeId: connection.runtimeId,
    },
  });
}

function sourceForConnectionOperation(operation: McpConnectionOperationType): McpConnectionOperationSource {
  switch (operation) {
    case "verify":
      return "user_verify";
    case "enable":
      return "enable";
    case "disable":
      return "config_change";
    case "remove":
      return "remove";
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseDeclaredTools(value: string): McpDeclaredTool[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): McpDeclaredTool | null => {
        if (!entry || typeof entry !== "object") return null;
        const obj = entry as Record<string, unknown>;
        const name = typeof obj.name === "string" ? obj.name : null;
        const description = typeof obj.description === "string" ? obj.description : "";
        const risk = obj.risk === "low" || obj.risk === "medium" || obj.risk === "high" ? obj.risk : "medium";
        return name ? { name, description, risk } : null;
      })
      .filter((t): t is McpDeclaredTool => t !== null);
  } catch {
    return [];
  }
}

function parseDiscoveredTools(value: string): McpDiscoveredTool[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): McpDiscoveredTool | null => {
        if (!entry || typeof entry !== "object") return null;
        const obj = entry as Record<string, unknown>;
        const name = typeof obj.name === "string" ? obj.name : null;
        const description = typeof obj.description === "string" ? obj.description : "";
        const inputSchema = (obj.inputSchema && typeof obj.inputSchema === "object" ? obj.inputSchema : {}) as Record<string, unknown>;
        const inputSchemaDigest = typeof obj.inputSchemaDigest === "string" ? obj.inputSchemaDigest : "";
        return name ? { name, description, inputSchema, inputSchemaDigest } : null;
      })
      .filter((t): t is McpDiscoveredTool => t !== null);
  } catch {
    return [];
  }
}

/** Re-exported for the daemon complete/fail routes to compute outcome from a verification result. */
export function classifyVerificationOutcome(result: McpVerificationResult, approvedTools: string[]): McpVerificationOutcome {
  if (result.status === "failed") return "failed";
  if (findMissingApprovedMcpTools(result.discoveredTools ?? [], approvedTools).length > 0) {
    return "degraded";
  }
  return "ready";
}

/** Returns approved tool names absent from the current discovery response. */
export function findMissingApprovedMcpTools(discoveredTools: McpDiscoveredTool[], approvedTools: string[]): string[] {
  const discovered = new Set(discoveredTools.map((tool) => tool.name));
  return approvedTools.filter((name) => !discovered.has(name));
}
