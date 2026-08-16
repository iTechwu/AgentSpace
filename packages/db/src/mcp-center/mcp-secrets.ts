// mcp-secrets 域：连接密钥 upsert / 读取 / 删除（密文存库，加密在 services 层）。
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "../database.ts";
import type {
  RuntimeMcpSecretRecord,
} from "../types.ts";
import {
  mapRuntimeMcpSecretRecord,
} from "./mcp-center-internal.ts";

export interface UpsertMcpSecretInput {
  connectionId: string;
  fieldName: string;
  encryptedValue: string;
  keyVersion: string;
  rotatedByUserId?: string;
  rotatedAt?: string;
}

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
      connection_id AS "connectionId",
      field_name AS "fieldName",
      encrypted_value AS "encryptedValue",
      key_version AS "keyVersion",
      rotated_at AS "rotatedAt",
      rotated_by_user_id AS "rotatedByUserId"
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
