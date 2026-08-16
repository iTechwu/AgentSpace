// mcp-discovery 域：连接发现快照 upsert / 最新读取。
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import type {
  RuntimeMcpDiscoverySnapshotRecord,
} from "../types.ts";
import {
  MCP_DISCOVERY_COLUMNS,
  mapRuntimeMcpDiscoverySnapshotRecord,
  throwMissing,
} from "./mcp-center-internal.ts";

export interface UpsertMcpDiscoverySnapshotInput {
  workspaceId?: string;
  connectionId: string;
  protocolVersion?: string;
  toolsMetadataJson: string;
  toolsFingerprint: string;
  verificationLatencyMs?: number;
  discoveredAt?: string;
}

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
