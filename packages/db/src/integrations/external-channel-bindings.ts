import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  requireExternalChannelBinding,
  selectExternalChannelBindingSql,
  mapExternalChannelBindingRecord,
  normalizeRequiredText,
  normalizeOptionalText,
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

export function upsertExternalChannelBindingSync(input: {
  workspaceId?: string;
  integrationId: string;
  channelName: string;
  externalChatId: string;
  externalChatType?: string;
  externalChatName?: string;
  status?: ExternalBindingStatus;
  syncMode?: ExternalChannelBindingSyncMode;
  metadataJson?: JsonInput;
  createdByUserId?: string;
}): ExternalChannelBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External channel binding integration id is required.");
  const channelName = normalizeRequiredText(input.channelName, "External channel binding channel name is required.");
  const externalChatId = normalizeRequiredText(input.externalChatId, "External channel binding external chat id is required.");
  const id = `external-channel-binding-${randomLikeId()}`;
  const now = new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_channel_binding (
       id,
       workspace_id,
       integration_id,
       channel_name,
       external_chat_id,
       external_chat_type,
       external_chat_name,
       status,
       sync_mode,
       metadata_json,
       created_by_user_id,
       created_at,
       updated_at,
       disabled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(integration_id, channel_name)
     DO UPDATE SET
       external_chat_id = EXCLUDED.external_chat_id,
       external_chat_type = EXCLUDED.external_chat_type,
       external_chat_name = EXCLUDED.external_chat_name,
       status = EXCLUDED.status,
       sync_mode = EXCLUDED.sync_mode,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = EXCLUDED.updated_at,
       disabled_at = CASE WHEN EXCLUDED.status = 'disabled' THEN COALESCE(external_channel_binding.disabled_at, EXCLUDED.updated_at) ELSE NULL END`,
  ).run(
    id,
    workspaceId,
    integrationId,
    channelName,
    externalChatId,
    normalizeOptionalText(input.externalChatType),
    normalizeOptionalText(input.externalChatName),
    input.status ?? "active",
    input.syncMode ?? "mirror",
    normalizeJsonInput(input.metadataJson, DEFAULT_JSON_OBJECT),
    normalizeOptionalText(input.createdByUserId),
    now,
    now,
  );

  const record = readExternalChannelBindingSync({ workspaceId, integrationId, channelName });
  if (!record) {
    throw new Error("External channel binding could not be read back.");
  }
  return record;
}

export function readExternalChannelBindingSync(input: {
  workspaceId?: string;
  integrationId: string;
  channelName: string;
}): ExternalChannelBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalChannelBindingSql()}
     WHERE workspace_id = ? AND integration_id = ? AND channel_name = ?`,
  ).get(workspaceId, input.integrationId.trim(), input.channelName.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalChannelBindingRecord(row) : null;
}

export function readExternalChannelBindingByExternalChatSync(input: {
  workspaceId?: string;
  integrationId: string;
  externalChatId: string;
}): ExternalChannelBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalChannelBindingSql()}
     WHERE workspace_id = ? AND integration_id = ? AND external_chat_id = ?`,
  ).get(workspaceId, input.integrationId.trim(), input.externalChatId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalChannelBindingRecord(row) : null;
}

export function readExternalChannelBindingByProviderChatSync(input: {
  workspaceId?: string;
  provider: string;
  externalChatId: string;
  tenantKey?: string;
  status?: ExternalBindingStatus;
}): ExternalChannelBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const provider = normalizeRequiredText(input.provider, "External channel binding provider is required.");
  const externalChatId = normalizeRequiredText(input.externalChatId, "External channel binding external chat id is required.");
  const tenantKey = normalizeOptionalText(input.tenantKey);
  const where = [
    "binding.workspace_id = ?",
    "integration.provider = ?",
    "binding.external_chat_id = ?",
    tenantKey ? "integration.tenant_key = ?" : "integration.tenant_key IS NULL",
  ];
  const params: unknown[] = [workspaceId, provider, externalChatId];
  if (tenantKey) {
    params.push(tenantKey);
  }
  if (input.status) {
    where.push("binding.status = ?");
    params.push(input.status);
  }

  const row = getDatabase().prepare(
    `${selectExternalChannelBindingSql("binding")}
     JOIN external_integration integration ON integration.id = binding.integration_id
     WHERE ${where.join(" AND ")}
     ORDER BY
       CASE binding.status WHEN 'active' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
       binding.updated_at DESC,
       binding.id DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;

  return row ? mapExternalChannelBindingRecord(row) : null;
}

export function listExternalChannelBindingsSync(options: {
  workspaceId?: string;
  integrationId: string;
  status?: ExternalBindingStatus;
}): ExternalChannelBindingRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?", "integration_id = ?"];
  const params: unknown[] = [workspaceId, options.integrationId.trim()];
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }

  const rows = getDatabase().prepare(
    `${selectExternalChannelBindingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, channel_name ASC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalChannelBindingRecord).filter((record): record is ExternalChannelBindingRecord => record !== null);
}

export function updateExternalChannelBindingStatusSync(input: {
  workspaceId?: string;
  bindingId: string;
  status: ExternalBindingStatus;
}): ExternalChannelBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_channel_binding
     SET status = ?,
         updated_at = ?,
         disabled_at = CASE WHEN ? = 'disabled' THEN COALESCE(disabled_at, ?) ELSE NULL END
     WHERE workspace_id = ? AND id = ?`,
  ).run(input.status, now, input.status, now, workspaceId, input.bindingId.trim());

  if (result.changes === 0) {
    throw new Error("External channel binding does not exist.");
  }
  return requireExternalChannelBinding({ workspaceId, bindingId: input.bindingId });
}


export type {
  ExternalChannelBindingRecord,
  ExternalChannelBindingSyncMode,
} from "../types.ts";
