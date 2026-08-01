import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  McpCatalogItemRecord,
  McpCatalogSource,
  McpConnectionOperationStatus,
  McpConnectionOperationType,
  McpConnectionStatus,
  McpRisk,
  McpToolCallOutcome,
  McpTransport,
  RuntimeMcpConnectionRecord,
  RuntimeMcpDiscoverySnapshotRecord,
  RuntimeMcpOperationRecord,
  RuntimeMcpSecretRecord,
  RuntimeMcpToolAuditRecord,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface UpsertMcpCatalogItemInput {
  id?: string;
  workspaceId?: string;
  source?: McpCatalogSource;
  slug: string;
  version?: string;
  transport: McpTransport;
  displayName: string;
  description?: string;
  allowedHostsJson?: string;
  configurationSchemaJson?: string;
  declaredToolsJson?: string;
  defaultApprovedToolsJson?: string;
  secretFieldsJson?: string;
  requiredRuntimeCapabilitiesJson?: string;
  dataDomainsJson?: string;
  risk?: McpRisk;
  endpointTemplate?: string;
  documentationUrl?: string;
}

export interface CreateMcpConnectionInput {
  workspaceId?: string;
  runtimeId: string;
  catalogItemId: string;
  endpoint: string;
  nonSecretParamsJson?: string;
  approvedToolsJson?: string;
  createdByUserId?: string;
}

export interface UpdateMcpConnectionConfigInput {
  connectionId: string;
  workspaceId?: string;
  endpoint?: string;
  nonSecretParamsJson?: string;
  approvedToolsJson?: string;
  endpointFingerprint?: string;
}

export interface UpdateMcpConnectionStatusInput {
  connectionId: string;
  workspaceId?: string;
  status: McpConnectionStatus;
  lastVerifiedAt?: string;
  endpointFingerprint?: string;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  lastStatus?: string | null;
}

export interface UpsertMcpSecretInput {
  connectionId: string;
  fieldName: string;
  encryptedValue: string;
  keyVersion: string;
  rotatedByUserId?: string;
  rotatedAt?: string;
}

export interface UpsertMcpDiscoverySnapshotInput {
  workspaceId?: string;
  connectionId: string;
  protocolVersion?: string;
  toolsMetadataJson: string;
  toolsFingerprint: string;
  verificationLatencyMs?: number;
  discoveredAt?: string;
}

export interface CreateMcpOperationInput {
  workspaceId?: string;
  runtimeId: string;
  connectionId: string;
  operation: McpConnectionOperationType;
  requestedByUserId?: string;
  requestSnapshotJson?: string;
}

export interface CompleteMcpOperationInput {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  /** When present (typically for a `verify` operation), a discovery snapshot is written and the connection status is updated. */
  verification?: {
    status: McpConnectionStatus;
    protocolVersion?: string;
    toolsMetadataJson: string;
    toolsFingerprint: string;
    latencyMs?: number;
    discoveredAt?: string;
  };
}

export interface FailMcpOperationInput {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage: string;
  /** Connection status to apply on failure (defaults to "failed" for verify operations). */
  connectionStatus?: McpConnectionStatus;
}

export interface RecordMcpToolAuditInput {
  workspaceId?: string;
  connectionId: string;
  taskId?: string;
  toolName: string;
  outcome: McpToolCallOutcome;
  latencyMs?: number;
  safeSummary?: string;
}

/* ------------------------------------------------------------------ */
/* Catalog items                                                       */
/* ------------------------------------------------------------------ */

export function upsertMcpCatalogItemSync(input: UpsertMcpCatalogItemInput): McpCatalogItemRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const slug = input.slug.trim();
  if (!slug) {
    throw new Error("MCP catalog item slug is required.");
  }
  const id = input.id?.trim() || `mcp-cat-${randomLikeId()}`;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO mcp_catalog_item (
        id,
        workspace_id,
        source,
        slug,
        version,
        transport,
        display_name,
        description,
        allowed_hosts_json,
        configuration_schema_json,
        declared_tools_json,
        default_approved_tools_json,
        secret_fields_json,
        required_runtime_capabilities_json,
        data_domains_json,
        risk,
        endpoint_template,
        documentation_url,
        synced_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, slug) DO UPDATE SET
        source = excluded.source,
        version = excluded.version,
        transport = excluded.transport,
        display_name = excluded.display_name,
        description = excluded.description,
        allowed_hosts_json = excluded.allowed_hosts_json,
        configuration_schema_json = excluded.configuration_schema_json,
        declared_tools_json = excluded.declared_tools_json,
        default_approved_tools_json = excluded.default_approved_tools_json,
        secret_fields_json = excluded.secret_fields_json,
        required_runtime_capabilities_json = excluded.required_runtime_capabilities_json,
        data_domains_json = excluded.data_domains_json,
        risk = excluded.risk,
        endpoint_template = excluded.endpoint_template,
        documentation_url = excluded.documentation_url,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    ).run(
      id,
      workspaceId,
      input.source ?? "workspace_private",
      slug,
      input.version?.trim() ?? "",
      input.transport,
      input.displayName.trim(),
      input.description?.trim() ?? "",
      input.allowedHostsJson ?? "[]",
      input.configurationSchemaJson ?? "{}",
      input.declaredToolsJson ?? "[]",
      input.defaultApprovedToolsJson ?? "[]",
      input.secretFieldsJson ?? "[]",
      input.requiredRuntimeCapabilitiesJson ?? "[]",
      input.dataDomainsJson ?? "[]",
      input.risk ?? "high",
      input.endpointTemplate?.trim() || null,
      input.documentationUrl?.trim() || null,
      now,
      now,
      now,
    );
  });
  const record = readMcpCatalogItemBySlugSync(slug, workspaceId);
  if (!record) {
    throw new Error("Failed to persist MCP catalog item.");
  }
  return record;
}

export function readMcpCatalogItemSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): McpCatalogItemRecord | null {
  const row = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapMcpCatalogItemRecord(row) : null;
}

export function readMcpCatalogItemBySlugSync(slug: string, workspaceId = DEFAULT_WORKSPACE_ID): McpCatalogItemRecord | null {
  const row = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item WHERE workspace_id = ? AND slug = ?`,
  ).get(workspaceId, slug.trim()) as Record<string, unknown> | undefined;
  return row ? mapMcpCatalogItemRecord(row) : null;
}

export function listMcpCatalogItemsSync(options: { workspaceId?: string; limit?: number } = {}): McpCatalogItemRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const rows = getDatabase().prepare(
    `${MCP_CATALOG_ITEM_COLUMNS} FROM mcp_catalog_item WHERE workspace_id = ? ORDER BY display_name ASC LIMIT ${limit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapMcpCatalogItemRecord).filter((r): r is McpCatalogItemRecord => r !== null);
}

export function deleteMcpCatalogItemSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const result = getDatabase().prepare(
    `DELETE FROM mcp_catalog_item WHERE id = ? AND workspace_id = ?`,
  ).run(id, workspaceId);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export function createMcpConnectionSync(input: CreateMcpConnectionInput): RuntimeMcpConnectionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const runtime = db.prepare(`SELECT id FROM agent_runtime WHERE id = ? AND workspace_id = ?`).get(input.runtimeId, workspaceId);
  if (!runtime) {
    throw new Error(`Runtime "${input.runtimeId}" does not exist in this workspace.`);
  }
  const catalog = db.prepare(`SELECT id FROM mcp_catalog_item WHERE id = ? AND workspace_id = ?`).get(input.catalogItemId, workspaceId);
  if (!catalog) {
    throw new Error(`MCP catalog item "${input.catalogItemId}" does not exist in this workspace.`);
  }
  const id = `mcp-conn-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runtime_mcp_connection (
      id, workspace_id, runtime_id, catalog_item_id, status,
      approved_tools_json, endpoint, non_secret_params_json, endpoint_fingerprint,
      last_verified_at, last_status, last_error_code, last_error_message,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued_verification', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.catalogItemId,
    input.approvedToolsJson ?? "[]",
    input.endpoint.trim(),
    input.nonSecretParamsJson ?? "{}",
    input.createdByUserId ?? null,
    now,
    now,
  );
  const record = readMcpConnectionSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to create MCP connection.");
  }
  return record;
}

export function readMcpConnectionSync(id: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpConnectionRecord | null {
  const row = getDatabase().prepare(
    `${MCP_CONNECTION_COLUMNS} FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRuntimeMcpConnectionRecord(row) : null;
}

export function listMcpConnectionsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  status?: McpConnectionStatus;
  limit?: number;
} = {}): RuntimeMcpConnectionRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const rows = getDatabase().prepare(
    `${MCP_CONNECTION_COLUMNS} FROM runtime_mcp_connection WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeMcpConnectionRecord).filter((r): r is RuntimeMcpConnectionRecord => r !== null);
}

export function listMcpConnectionsForRuntimeSync(options: {
  workspaceId?: string;
  runtimeId: string;
}): RuntimeMcpConnectionRecord[] {
  return listMcpConnectionsSync({ workspaceId: options.workspaceId, runtimeId: options.runtimeId, limit: 500 });
}

/** Connections in `ready` status — used when assembling task context. Returns no secret material. */
export function listReadyMcpConnectionsForRuntimeSync(options: {
  workspaceId?: string;
  runtimeId: string;
}): RuntimeMcpConnectionRecord[] {
  return listMcpConnectionsSync({ workspaceId: options.workspaceId, runtimeId: options.runtimeId, status: "ready", limit: 500 });
}

export function updateMcpConnectionConfigSync(input: UpdateMcpConnectionConfigInput): RuntimeMcpConnectionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const sets = ["updated_at = ?", "status = 'queued_verification'", "last_verified_at = NULL", "endpoint_fingerprint = NULL"];
  const params: unknown[] = [now];
  if (input.endpoint !== undefined) {
    sets.push("endpoint = ?");
    params.push(input.endpoint.trim());
  }
  if (input.nonSecretParamsJson !== undefined) {
    sets.push("non_secret_params_json = ?");
    params.push(input.nonSecretParamsJson);
  }
  if (input.approvedToolsJson !== undefined) {
    sets.push("approved_tools_json = ?");
    params.push(input.approvedToolsJson);
  }
  params.push(input.connectionId, workspaceId);
  const result = db.prepare(
    `UPDATE runtime_mcp_connection SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
  ).run(...params);
  if (result.changes === 0) {
    throw new Error(`MCP connection "${input.connectionId}" does not exist in this workspace.`);
  }
  const record = readMcpConnectionSync(input.connectionId, workspaceId);
  if (!record) {
    throw new Error(`MCP connection "${input.connectionId}" does not exist in this workspace.`);
  }
  return record;
}

export function updateMcpConnectionStatusSync(input: UpdateMcpConnectionStatusInput): RuntimeMcpConnectionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const sets = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [input.status, now];
  if (input.lastVerifiedAt !== undefined) {
    sets.push("last_verified_at = ?");
    params.push(input.lastVerifiedAt ?? null);
  }
  if (input.endpointFingerprint !== undefined) {
    sets.push("endpoint_fingerprint = ?");
    params.push(input.endpointFingerprint ?? null);
  }
  if (input.lastStatus !== undefined) {
    sets.push("last_status = ?");
    params.push(input.lastStatus ?? null);
  }
  if (input.lastErrorCode !== undefined) {
    sets.push("last_error_code = ?");
    params.push(input.lastErrorCode ?? null);
  }
  if (input.lastErrorMessage !== undefined) {
    sets.push("last_error_message = ?");
    params.push(input.lastErrorMessage ?? null);
  }
  params.push(input.connectionId, workspaceId);
  const result = db.prepare(
    `UPDATE runtime_mcp_connection SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`,
  ).run(...params);
  if (result.changes === 0) {
    throw new Error(`MCP connection "${input.connectionId}" does not exist in this workspace.`);
  }
  const record = readMcpConnectionSync(input.connectionId, workspaceId);
  if (!record) {
    throw new Error(`MCP connection "${input.connectionId}" does not exist in this workspace.`);
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* Secrets (stored opaque; encryption happens in services)             */
/* ------------------------------------------------------------------ */

export function upsertMcpSecretSync(input: UpsertMcpSecretInput): void {
  const now = input.rotatedAt ?? new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_mcp_secret (connection_id, field_name, encrypted_value, key_version, rotated_at, rotated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (connection_id, field_name) DO UPDATE SET
       encrypted_value = excluded.encrypted_value,
       key_version = excluded.key_version,
       rotated_at = excluded.rotated_at,
       rotated_by_user_id = excluded.rotated_by_user_id`,
  ).run(
    input.connectionId,
    input.fieldName.trim(),
    input.encryptedValue,
    input.keyVersion,
    now,
    input.rotatedByUserId ?? null,
  );
}

export function upsertMcpSecretsSync(inputs: UpsertMcpSecretInput[]): void {
  if (inputs.length === 0) {
    return;
  }
  const db = getDatabase();
  withTransaction(db, () => {
    for (const item of inputs) {
      upsertMcpSecretSync(item);
    }
  });
}

export function readMcpConnectionSecretsSync(connectionId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpSecretRecord[] {
  const row = getDatabase().prepare(
    `SELECT id FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ?`,
  ).get(connectionId, workspaceId);
  if (!row) {
    return [];
  }
  const rows = getDatabase().prepare(
    `SELECT
      connection_id AS connectionId,
      field_name AS fieldName,
      encrypted_value AS encryptedValue,
      key_version AS keyVersion,
      rotated_at AS rotatedAt,
      rotated_by_user_id AS rotatedByUserId
     FROM runtime_mcp_secret WHERE connection_id = ?`,
  ).all(connectionId) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeMcpSecretRecord).filter((r): r is RuntimeMcpSecretRecord => r !== null);
}

export function deleteMcpSecretSync(connectionId: string, fieldName: string, workspaceId = DEFAULT_WORKSPACE_ID): boolean {
  const db = getDatabase();
  const row = db.prepare(`SELECT id FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ?`).get(connectionId, workspaceId);
  if (!row) {
    return false;
  }
  const result = db.prepare(
    `DELETE FROM runtime_mcp_secret WHERE connection_id = ? AND field_name = ?`,
  ).run(connectionId, fieldName.trim());
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Discovery snapshots                                                 */
/* ------------------------------------------------------------------ */

export function upsertMcpDiscoverySnapshotSync(input: UpsertMcpDiscoverySnapshotInput): RuntimeMcpDiscoverySnapshotRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `mcp-snap-${randomLikeId()}`;
  const discoveredAt = input.discoveredAt ?? new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_mcp_discovery_snapshot (
      id, workspace_id, connection_id, protocol_version, tools_metadata_json, tools_fingerprint, discovered_at, verification_latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.connectionId,
    input.protocolVersion ?? null,
    input.toolsMetadataJson,
    input.toolsFingerprint,
    discoveredAt,
    input.verificationLatencyMs ?? null,
  );
  const row = getDatabase().prepare(
    `${MCP_DISCOVERY_COLUMNS} FROM runtime_mcp_discovery_snapshot WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  const record = row ? mapRuntimeMcpDiscoverySnapshotRecord(row) : null;
  if (!record) {
    throwMissing("discovery snapshot");
  }
  return record;
}

export function readLatestMcpDiscoverySnapshotSync(connectionId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpDiscoverySnapshotRecord | null {
  const row = getDatabase().prepare(
    `${MCP_DISCOVERY_COLUMNS} FROM runtime_mcp_discovery_snapshot
     WHERE connection_id = ? AND workspace_id = ?
     ORDER BY discovered_at DESC LIMIT 1`,
  ).get(connectionId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRuntimeMcpDiscoverySnapshotRecord(row) : null;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export function createMcpOperationSync(input: CreateMcpOperationInput): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `mcp-op-${randomLikeId()}`;
  const connection = db.prepare(
    `SELECT id, runtime_id FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ? AND runtime_id = ?`,
  ).get(input.connectionId, workspaceId, input.runtimeId) as Record<string, unknown> | undefined;
  if (!connection) {
    throw new Error(`MCP connection "${input.connectionId}" does not exist on runtime "${input.runtimeId}" in this workspace.`);
  }
  db.prepare(
    `INSERT INTO runtime_mcp_operation (
      id, workspace_id, runtime_id, connection_id, operation, status,
      request_snapshot_json, requested_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.connectionId,
    input.operation,
    input.requestSnapshotJson ?? "{}",
    input.requestedByUserId ?? null,
    now,
  );
  const record = readMcpOperationSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to create MCP operation.");
  }
  return record;
}

export function readMcpOperationSync(operationId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpOperationRecord | null {
  const row = getDatabase().prepare(
    `${MCP_OPERATION_COLUMNS} FROM runtime_mcp_operation WHERE id = ? AND workspace_id = ?`,
  ).get(operationId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRuntimeMcpOperationRecord(row) : null;
}

export function listMcpOperationsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  connectionId?: string;
  status?: McpConnectionOperationStatus;
  limit?: number;
} = {}): RuntimeMcpOperationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.connectionId) {
    where.push("connection_id = ?");
    params.push(options.connectionId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${MCP_OPERATION_COLUMNS} FROM runtime_mcp_operation WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeMcpOperationRecord).filter((r): r is RuntimeMcpOperationRecord => r !== null);
}

export function listMcpOperationsForConnectionSync(connectionId: string, workspaceId = DEFAULT_WORKSPACE_ID, limit = 50): RuntimeMcpOperationRecord[] {
  return listMcpOperationsSync({ workspaceId, connectionId, limit });
}

/**
 * Fences all unfinished work for a connection before its configuration or
 * availability changes. A daemon may still report a cancelled operation, but
 * complete/fail will then be a no-op and cannot restore stale readiness.
 */
export function cancelUnfinishedMcpOperationsForConnectionSync(input: {
  connectionId: string;
  workspaceId?: string;
}): number {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE runtime_mcp_operation
     SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
     WHERE connection_id = ? AND workspace_id = ? AND status IN ('pending', 'claimed', 'running')`,
  ).run(new Date().toISOString(), input.connectionId, workspaceId);
  return result.changes;
}

export function claimNextMcpOperationForRuntimeSync(input: {
  workspaceId?: string;
  runtimeId: string;
}): RuntimeMcpOperationRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  let claimedId: string | null = null;
  withTransaction(db, () => {
    const row = db.prepare(
      `SELECT operation.id, operation.connection_id, operation.operation
       FROM runtime_mcp_operation operation
       JOIN runtime_mcp_connection connection
         ON connection.id = operation.connection_id AND connection.workspace_id = operation.workspace_id
       WHERE operation.workspace_id = ? AND operation.runtime_id = ? AND operation.status = 'pending'
         AND (operation.operation = 'remove' OR connection.status = 'queued_verification')
       ORDER BY operation.created_at ASC LIMIT 1`,
    ).get(workspaceId, input.runtimeId) as Record<string, unknown> | undefined;
    if (typeof row?.id !== "string") {
      return;
    }
    const result = db.prepare(
      `UPDATE runtime_mcp_operation SET status = 'claimed' WHERE id = ? AND status = 'pending'`,
    ).run(row.id);
    if (result.changes > 0) {
      if (row.operation !== "remove") {
        const connectionResult = db.prepare(
          `UPDATE runtime_mcp_connection
           SET status = 'verifying', updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'queued_verification'`,
        ).run(new Date().toISOString(), row.connection_id, workspaceId);
        if (connectionResult.changes === 0) {
          db.prepare(
            `UPDATE runtime_mcp_operation SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'claimed'`,
          ).run(new Date().toISOString(), row.id);
          return;
        }
      }
      claimedId = row.id;
    }
  });
  if (!claimedId) {
    return null;
  }
  return readMcpOperationSync(claimedId, workspaceId);
}

export function startMcpOperationSync(operationId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE runtime_mcp_operation SET status = 'running', started_at = COALESCE(started_at, ?)
     WHERE id = ? AND workspace_id = ? AND status = 'claimed'`,
  ).run(now, operationId, workspaceId);
  const record = readMcpOperationSync(operationId, workspaceId);
  if (!record) {
    throw new Error(`MCP operation "${operationId}" does not exist.`);
  }
  return record;
}

export function completeMcpOperationSync(input: CompleteMcpOperationInput): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let completed: RuntimeMcpOperationRecord | null = null;
  withTransaction(db, () => {
    const update = db.prepare(
      `UPDATE runtime_mcp_operation
       SET status = 'succeeded', safe_stdout_tail = ?, safe_stderr_tail = ?, completed_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running'`,
    ).run(input.safeStdoutTail ?? null, input.safeStderrTail ?? null, now, input.operationId, workspaceId);
    completed = readMcpOperationSync(input.operationId, workspaceId);
    if (!completed) {
      throw new Error(`MCP operation "${input.operationId}" does not exist.`);
    }
    if (update.changes === 0) {
      return;
    }
    if (completed.operation === "remove") {
      // Removing: cascade deletes secrets, snapshots, operations, audit references.
      db.prepare(`DELETE FROM runtime_mcp_connection WHERE id = ? AND workspace_id = ?`).run(completed.connectionId, workspaceId);
      return;
    }
    if (input.verification) {
      const snap = upsertMcpDiscoverySnapshotSync({
        workspaceId,
        connectionId: completed.connectionId,
        protocolVersion: input.verification.protocolVersion,
        toolsMetadataJson: input.verification.toolsMetadataJson,
        toolsFingerprint: input.verification.toolsFingerprint,
        verificationLatencyMs: input.verification.latencyMs,
        discoveredAt: input.verification.discoveredAt ?? now,
      });
      db.prepare(
        `UPDATE runtime_mcp_connection
         SET status = ?, last_verified_at = ?, endpoint_fingerprint = ?,
             last_status = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).run(
        input.verification.status,
        now,
        snap.toolsFingerprint,
        input.verification.status,
        now,
        completed.connectionId,
        workspaceId,
      );
      return;
    }
    // Non-verify completion (enable/disable): clear transient error state.
    db.prepare(
      `UPDATE runtime_mcp_connection SET last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ).run(now, completed.connectionId, workspaceId);
  });
  if (!completed) {
    throw new Error(`MCP operation "${input.operationId}" does not exist.`);
  }
  return completed;
}

export function failMcpOperationSync(input: FailMcpOperationInput): RuntimeMcpOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let failed: RuntimeMcpOperationRecord | null = null;
  withTransaction(db, () => {
    const update = db.prepare(
      `UPDATE runtime_mcp_operation
       SET status = 'failed', safe_stdout_tail = ?, safe_stderr_tail = ?, error_code = ?, error_message = ?, completed_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running'`,
    ).run(
      input.safeStdoutTail ?? null,
      input.safeStderrTail ?? null,
      input.errorCode ?? null,
      input.errorMessage,
      now,
      input.operationId,
      workspaceId,
    );
    failed = readMcpOperationSync(input.operationId, workspaceId);
    if (!failed) {
      throw new Error(`MCP operation "${input.operationId}" does not exist.`);
    }
    if (update.changes === 0) {
      return;
    }
    if (failed.operation === "remove") {
      return;
    }
    const connectionStatus: McpConnectionStatus = input.connectionStatus ?? (failed.operation === "verify" ? "failed" : "degraded");
    db.prepare(
      `UPDATE runtime_mcp_connection
       SET status = ?, last_status = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      connectionStatus,
      connectionStatus,
      input.errorCode ?? null,
      input.errorMessage,
      now,
      failed.connectionId,
      workspaceId,
    );
  });
  if (!failed) {
    throw new Error(`MCP operation "${input.operationId}" does not exist.`);
  }
  return failed;
}

/* ------------------------------------------------------------------ */
/* Tool-call audit                                                     */
/* ------------------------------------------------------------------ */

export function recordMcpToolAuditSync(input: RecordMcpToolAuditInput): RuntimeMcpToolAuditRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `mcp-audit-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO runtime_mcp_tool_audit (id, workspace_id, connection_id, task_id, tool_name, outcome, latency_ms, safe_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.connectionId,
    input.taskId ?? null,
    input.toolName,
    input.outcome,
    input.latencyMs ?? null,
    input.safeSummary ?? null,
    now,
  );
  const row = getDatabase().prepare(
    `${MCP_TOOL_AUDIT_COLUMNS} FROM runtime_mcp_tool_audit WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  const record = row ? mapRuntimeMcpToolAuditRecord(row) : null;
  if (!record) {
    throwMissing("tool audit");
  }
  return record;
}

export function listMcpToolAuditsSync(options: {
  workspaceId?: string;
  connectionId?: string;
  taskId?: string;
  limit?: number;
} = {}): RuntimeMcpToolAuditRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.connectionId) {
    where.push("connection_id = ?");
    params.push(options.connectionId);
  }
  if (options.taskId) {
    where.push("task_id = ?");
    params.push(options.taskId);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = getDatabase().prepare(
    `${MCP_TOOL_AUDIT_COLUMNS} FROM runtime_mcp_tool_audit WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeMcpToolAuditRecord).filter((r): r is RuntimeMcpToolAuditRecord => r !== null);
}

/* ------------------------------------------------------------------ */
/* Column selectors + mappers                                          */
/* ------------------------------------------------------------------ */

const MCP_CATALOG_ITEM_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, source, slug, version, transport,
  display_name AS displayName, description,
  allowed_hosts_json AS allowedHostsJson,
  configuration_schema_json AS configurationSchemaJson,
  declared_tools_json AS declaredToolsJson,
  default_approved_tools_json AS defaultApprovedToolsJson,
  secret_fields_json AS secretFieldsJson,
  required_runtime_capabilities_json AS requiredRuntimeCapabilitiesJson,
  data_domains_json AS dataDomainsJson,
  risk, endpoint_template AS endpointTemplate, documentation_url AS documentationUrl,
  synced_at AS syncedAt, created_at AS createdAt, updated_at AS updatedAt`;

const MCP_CONNECTION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId, catalog_item_id AS catalogItemId,
  status, approved_tools_json AS approvedToolsJson, endpoint,
  non_secret_params_json AS nonSecretParamsJson, endpoint_fingerprint AS endpointFingerprint,
  last_verified_at AS lastVerifiedAt, last_status AS lastStatus,
  last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage,
  created_by_user_id AS createdByUserId, created_at AS createdAt, updated_at AS updatedAt`;

const MCP_DISCOVERY_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, connection_id AS connectionId,
  protocol_version AS protocolVersion, tools_metadata_json AS toolsMetadataJson,
  tools_fingerprint AS toolsFingerprint, discovered_at AS discoveredAt,
  verification_latency_ms AS verificationLatencyMs`;

const MCP_OPERATION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId, connection_id AS connectionId,
  operation, status, request_snapshot_json AS requestSnapshotJson,
  safe_stdout_tail AS safeStdoutTail, safe_stderr_tail AS safeStderrTail,
  error_code AS errorCode, error_message AS errorMessage,
  requested_by_user_id AS requestedByUserId,
  created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt`;

const MCP_TOOL_AUDIT_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, connection_id AS connectionId, task_id AS taskId,
  tool_name AS toolName, outcome, latency_ms AS latencyMs, safe_summary AS safeSummary,
  created_at AS createdAt`;

function mapMcpCatalogItemRecord(value: Record<string, unknown>): McpCatalogItemRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !isMcpCatalogSource(value.source) ||
    typeof value.slug !== "string" ||
    typeof value.version !== "string" ||
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
    syncedAt: value.syncedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapRuntimeMcpConnectionRecord(value: Record<string, unknown>): RuntimeMcpConnectionRecord | null {
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
    typeof value.updatedAt !== "string"
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
    lastStatus: readOptionalString(value.lastStatus),
    lastErrorCode: readOptionalString(value.lastErrorCode),
    lastErrorMessage: readOptionalString(value.lastErrorMessage),
    createdByUserId: readOptionalString(value.createdByUserId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapRuntimeMcpSecretRecord(value: Record<string, unknown>): RuntimeMcpSecretRecord | null {
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

function mapRuntimeMcpDiscoverySnapshotRecord(value: Record<string, unknown>): RuntimeMcpDiscoverySnapshotRecord | null {
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

function mapRuntimeMcpOperationRecord(value: Record<string, unknown>): RuntimeMcpOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.connectionId !== "string" ||
    !isMcpConnectionOperationType(value.operation) ||
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
    status: value.status,
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

function mapRuntimeMcpToolAuditRecord(value: Record<string, unknown>): RuntimeMcpToolAuditRecord | null {
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
    createdAt: value.createdAt,
  };
}

function isMcpTransport(value: unknown): value is McpTransport {
  return value === "streamable_http" || value === "sse" || value === "managed_service" || value === "managed_stdio";
}
function isMcpRisk(value: unknown): value is McpRisk {
  return value === "low" || value === "medium" || value === "high";
}
function isMcpCatalogSource(value: unknown): value is McpCatalogSource {
  return value === "official" || value === "verified_partner" || value === "workspace_private";
}
function isMcpConnectionStatus(value: unknown): value is McpConnectionStatus {
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
function isMcpConnectionOperationType(value: unknown): value is McpConnectionOperationType {
  return value === "verify" || value === "enable" || value === "disable" || value === "remove";
}
function isMcpConnectionOperationStatus(value: unknown): value is McpConnectionOperationStatus {
  return value === "pending" || value === "claimed" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}
function isMcpToolCallOutcome(value: unknown): value is McpToolCallOutcome {
  return value === "succeeded" || value === "failed";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function throwMissing(label: string): never {
  throw new Error(`Failed to persist MCP ${label}.`);
}
