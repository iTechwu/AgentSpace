import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  requireExternalUserBinding,
  selectExternalUserBindingSql,
  mapExternalUserBindingRecord,
  normalizeRequiredText,
  normalizeOptionalText,
  normalizeOptionalEmail,
  normalizeJsonInput,
} from "./external-integration-internal.ts";
import type {
  ExternalBindingStatus,
  ExternalChannelBindingRecord,
  ExternalChannelBindingSyncMode,
  ExternalDataOperationActorType,
  ExternalDataOperationRunRecord,
  ExternalDataOperationRunStatus,
  ExternalIntegrationEventRecord,
  ExternalIntegrationEventStatus,
  ExternalIntegrationHealthStatus,
  ExternalIntegrationProvider,
  ExternalIntegrationRecord,
  ExternalIntegrationStatus,
  ExternalIntegrationTransportMode,
  ExternalMessageDirection,
  ExternalMessageMappingRecord,
  ExternalMessageOutboxRecord,
  ExternalMessageOutboxStatus,
  ExternalResourceBindingDofeAgentType,
  ExternalResourceBindingProviderType,
  ExternalResourceBindingRecord,
  ExternalThreadBindingRecord,
  ExternalThreadBindingStatus,
  ExternalUserBindingRecord,
} from "../types.ts";

export function upsertExternalUserBindingSync(input: {
  workspaceId?: string;
  integrationId: string;
  userId: string;
  externalUserId: string;
  externalUnionId?: string;
  externalOpenId?: string;
  externalEmail?: string;
  displayName?: string;
  status?: ExternalBindingStatus;
  metadataJson?: JsonInput;
  lastSeenAt?: string;
}): ExternalUserBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External user binding integration id is required.");
  const userId = normalizeRequiredText(input.userId, "External user binding user id is required.");
  const externalUserId = normalizeRequiredText(input.externalUserId, "External user binding external user id is required.");
  const id = `external-user-binding-${randomLikeId()}`;
  const now = new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_user_binding (
       id,
       workspace_id,
       integration_id,
       user_id,
       external_user_id,
       external_union_id,
       external_open_id,
       external_email,
       display_name,
       status,
       metadata_json,
       created_at,
       updated_at,
       last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration_id, user_id)
     DO UPDATE SET
       external_user_id = EXCLUDED.external_user_id,
       external_union_id = EXCLUDED.external_union_id,
       external_open_id = EXCLUDED.external_open_id,
       external_email = EXCLUDED.external_email,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = EXCLUDED.updated_at,
       last_seen_at = EXCLUDED.last_seen_at`,
  ).run(
    id,
    workspaceId,
    integrationId,
    userId,
    externalUserId,
    normalizeOptionalText(input.externalUnionId),
    normalizeOptionalText(input.externalOpenId),
    normalizeOptionalEmail(input.externalEmail),
    normalizeOptionalText(input.displayName),
    input.status ?? "active",
    normalizeJsonInput(input.metadataJson, DEFAULT_JSON_OBJECT),
    now,
    now,
    normalizeOptionalText(input.lastSeenAt),
  );

  const record = readExternalUserBindingSync({ workspaceId, integrationId, userId });
  if (!record) {
    throw new Error("External user binding could not be read back.");
  }
  return record;
}

export function readExternalUserBindingSync(input: {
  workspaceId?: string;
  integrationId: string;
  userId: string;
}): ExternalUserBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalUserBindingSql()}
     WHERE workspace_id = ? AND integration_id = ? AND user_id = ?`,
  ).get(workspaceId, input.integrationId.trim(), input.userId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalUserBindingRecord(row) : null;
}

export function readExternalUserBindingByExternalUserSync(input: {
  workspaceId?: string;
  integrationId: string;
  externalUserId: string;
}): ExternalUserBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalUserBindingSql()}
     WHERE workspace_id = ? AND integration_id = ? AND external_user_id = ?`,
  ).get(workspaceId, input.integrationId.trim(), input.externalUserId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalUserBindingRecord(row) : null;
}

export function readExternalUserBindingByIdSync(input: {
  workspaceId?: string;
  bindingId: string;
}): ExternalUserBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalUserBindingSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, input.bindingId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalUserBindingRecord(row) : null;
}

export function listExternalUserBindingsSync(options: {
  workspaceId?: string;
  integrationId: string;
  status?: ExternalBindingStatus;
}): ExternalUserBindingRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?", "integration_id = ?"];
  const params: unknown[] = [workspaceId, options.integrationId.trim()];
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }

  const rows = getDatabase().prepare(
    `${selectExternalUserBindingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalUserBindingRecord).filter((record): record is ExternalUserBindingRecord => record !== null);
}

export function updateExternalUserBindingStatusSync(input: {
  workspaceId?: string;
  bindingId: string;
  status: ExternalBindingStatus;
}): ExternalUserBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_user_binding
     SET status = ?,
         updated_at = ?,
         last_seen_at = CASE WHEN ? = 'active' THEN last_seen_at ELSE NULL END
     WHERE workspace_id = ? AND id = ?`,
  ).run(input.status, now, input.status, workspaceId, input.bindingId.trim());

  if (result.changes === 0) {
    throw new Error("External user binding does not exist.");
  }
  return requireExternalUserBinding({ workspaceId, bindingId: input.bindingId });
}


export type { ExternalBindingStatus, ExternalUserBindingRecord } from "../types.ts";
