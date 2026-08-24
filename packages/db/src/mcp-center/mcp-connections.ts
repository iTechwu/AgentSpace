// mcp-connections 域：运行时 MCP 连接 CRUD / 配置 / 状态收敛。
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import type {
  McpConnectionStatus,
  RuntimeMcpConnectionRecord,
} from "../types.ts";
import {
  MCP_CONNECTION_COLUMNS,
  mapRuntimeMcpConnectionRecord,
} from "./mcp-center-internal.ts";

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

export interface UpdateMcpConnectionApprovedToolsInput {
  connectionId: string;
  workspaceId?: string;
  approvedToolsJson: string;
  /** Re-validation is required for an active connection after its tool surface changes. */
  reverify?: boolean;
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
  nextHealthCheckAt?: string | null;
  healthCheckConsecutiveFailures?: number;
}

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
      last_verified_at, next_health_check_at, health_check_consecutive_failures,
      last_status, last_error_code, last_error_message,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued_verification', ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?, ?)`,
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
  const sets = ["updated_at = ?", "status = 'queued_verification'", "last_verified_at = NULL", "endpoint_fingerprint = NULL", "next_health_check_at = NULL", "health_check_consecutive_failures = 0"];
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

/**
 * Reconciles a connection's service-level tool set without changing endpoint or
 * secrets. Disabled connections deliberately remain disabled; active ones can
 * be fenced until the caller queues a fresh verification operation.
 */
export function updateMcpConnectionApprovedToolsSync(input: UpdateMcpConnectionApprovedToolsInput): RuntimeMcpConnectionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const reverify = input.reverify === true;
  const result = db.prepare(
    `UPDATE runtime_mcp_connection
     SET approved_tools_json = ?, updated_at = ?,
         status = CASE WHEN ? AND status <> 'disabled' THEN 'queued_verification' ELSE status END,
         last_verified_at = CASE WHEN ? AND status <> 'disabled' THEN NULL ELSE last_verified_at END,
         endpoint_fingerprint = CASE WHEN ? AND status <> 'disabled' THEN NULL ELSE endpoint_fingerprint END,
         next_health_check_at = CASE WHEN ? AND status <> 'disabled' THEN NULL ELSE next_health_check_at END,
         health_check_consecutive_failures = CASE WHEN ? AND status <> 'disabled' THEN 0 ELSE health_check_consecutive_failures END
     WHERE id = ? AND workspace_id = ?`,
  ).run(
    input.approvedToolsJson,
    now,
    reverify,
    reverify,
    reverify,
    reverify,
    reverify,
    input.connectionId,
    workspaceId,
  );
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
  if (input.nextHealthCheckAt !== undefined) {
    sets.push("next_health_check_at = ?");
    params.push(input.nextHealthCheckAt ?? null);
  }
  if (input.healthCheckConsecutiveFailures !== undefined) {
    sets.push("health_check_consecutive_failures = ?");
    params.push(input.healthCheckConsecutiveFailures);
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
