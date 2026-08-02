import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type { StoredWorkspaceServiceSecretRecord } from "./types.ts";

const SERVICE_SECRET_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, service_catalog_id, name,
  encrypted_value, created_at AS createdAt, updated_at AS updatedAt`;

export function upsertWorkspaceServiceSecretSync(input: {
  workspaceId?: string;
  serviceCatalogId: string;
  name: string;
  encryptedValue: string;
}): StoredWorkspaceServiceSecretRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `svc-secret-${randomLikeId()}`;
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO workspace_service_secret (
        id, workspace_id, service_catalog_id, name, encrypted_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, service_catalog_id, name) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        updated_at = excluded.updated_at`,
    ).run(id, workspaceId, input.serviceCatalogId, input.name, input.encryptedValue, now, now);
  });
  // On overwrite the row keeps its ORIGINAL id — read back by the natural key.
  const record = listWorkspaceServiceSecretsSync(input.serviceCatalogId, workspaceId)
    .find((secret) => secret.name === input.name);
  if (!record) {
    throw new Error("Failed to persist workspace service secret.");
  }
  return record;
}

export function readWorkspaceServiceSecretSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredWorkspaceServiceSecretRecord | null {
  const row = getDatabase().prepare(
    `${SERVICE_SECRET_COLUMNS} FROM workspace_service_secret WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapSecretRecord(row) : null;
}

export function listWorkspaceServiceSecretsSync(
  serviceCatalogId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredWorkspaceServiceSecretRecord[] {
  const rows = getDatabase().prepare(
    `${SERVICE_SECRET_COLUMNS} FROM workspace_service_secret
     WHERE workspace_id = ? AND service_catalog_id = ? ORDER BY name ASC`,
  ).all(workspaceId, serviceCatalogId) as Array<Record<string, unknown>>;
  return rows.map(mapSecretRecord).filter((r): r is StoredWorkspaceServiceSecretRecord => r !== null);
}

export function deleteWorkspaceServiceSecretSync(input: {
  workspaceId?: string;
  serviceCatalogId: string;
  name: string;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `DELETE FROM workspace_service_secret WHERE workspace_id = ? AND service_catalog_id = ? AND name = ?`,
  ).run(workspaceId, input.serviceCatalogId, input.name);
  return result.changes > 0;
}

function mapSecretRecord(value: Record<string, unknown>): StoredWorkspaceServiceSecretRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.serviceCatalogId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.encryptedValue !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    serviceCatalogId: value.serviceCatalogId,
    name: value.name,
    encryptedValue: value.encryptedValue,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
