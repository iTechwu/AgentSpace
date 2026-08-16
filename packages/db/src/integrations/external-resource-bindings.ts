import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  requireExternalResourceBinding,
  selectExternalResourceBindingSql,
  mapExternalResourceBindingRecord,
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

export function upsertExternalResourceBindingSync(input: {
  workspaceId?: string;
  integrationId: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
  providerResourceUrl?: string;
  dofeAgentResourceType: ExternalResourceBindingDofeAgentType;
  dofeAgentResourceId: string;
  channelName?: string;
  displayName?: string;
  status?: ExternalBindingStatus;
  permissionsJson?: JsonInput;
  metadataJson?: JsonInput;
  createdByUserId?: string;
}): ExternalResourceBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External resource binding integration id is required.");
  const providerResourceType = normalizeRequiredText(input.providerResourceType, "External resource provider type is required.");
  const providerResourceToken = normalizeRequiredText(input.providerResourceToken, "External resource token is required.");
  const dofeAgentResourceType = normalizeRequiredText(input.dofeAgentResourceType, "DofeAgent resource type is required.");
  const dofeAgentResourceId = normalizeRequiredText(input.dofeAgentResourceId, "DofeAgent resource id is required.");
  const id = `external-resource-binding-${randomLikeId()}`;
  const now = new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_resource_binding (
       id,
       workspace_id,
       integration_id,
       provider_resource_type,
       provider_resource_token,
       provider_resource_url,
       dofe_agent_resource_type,
       dofe_agent_resource_id,
       channel_name,
       display_name,
       status,
       permissions_json,
       metadata_json,
       created_by_user_id,
       created_at,
       updated_at,
       archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(integration_id, provider_resource_type, provider_resource_token)
     DO UPDATE SET
       provider_resource_url = EXCLUDED.provider_resource_url,
       dofe_agent_resource_type = EXCLUDED.dofe_agent_resource_type,
       dofe_agent_resource_id = EXCLUDED.dofe_agent_resource_id,
       channel_name = EXCLUDED.channel_name,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       permissions_json = EXCLUDED.permissions_json,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = EXCLUDED.updated_at,
       archived_at = CASE WHEN EXCLUDED.status = 'archived' THEN COALESCE(external_resource_binding.archived_at, EXCLUDED.updated_at) ELSE NULL END`,
  ).run(
    id,
    workspaceId,
    integrationId,
    providerResourceType,
    providerResourceToken,
    normalizeOptionalText(input.providerResourceUrl),
    dofeAgentResourceType,
    dofeAgentResourceId,
    normalizeOptionalText(input.channelName),
    normalizeOptionalText(input.displayName),
    input.status ?? "active",
    normalizeJsonInput(input.permissionsJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.metadataJson, DEFAULT_JSON_OBJECT),
    normalizeOptionalText(input.createdByUserId),
    now,
    now,
  );

  const record = readExternalResourceBindingByKeySync({
    workspaceId,
    integrationId,
    providerResourceType,
    providerResourceToken,
  });
  if (!record) {
    throw new Error("External resource binding could not be read back.");
  }
  return record;
}

export function readExternalResourceBindingByKeySync(input: {
  workspaceId?: string;
  integrationId: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
}): ExternalResourceBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalResourceBindingSql()}
     WHERE workspace_id = ?
       AND integration_id = ?
       AND provider_resource_type = ?
       AND provider_resource_token = ?`,
  ).get(
    workspaceId,
    input.integrationId.trim(),
    input.providerResourceType.trim(),
    input.providerResourceToken.trim(),
  ) as Record<string, unknown> | undefined;

  return row ? mapExternalResourceBindingRecord(row) : null;
}

export function listExternalResourceBindingsSync(options: {
  workspaceId?: string;
  integrationId: string;
  channelName?: string;
  status?: ExternalBindingStatus;
}): ExternalResourceBindingRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?", "integration_id = ?"];
  const params: unknown[] = [workspaceId, options.integrationId.trim()];
  if (options.channelName?.trim()) {
    where.push("channel_name = ?");
    params.push(options.channelName.trim());
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }

  const rows = getDatabase().prepare(
    `${selectExternalResourceBindingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalResourceBindingRecord).filter((record): record is ExternalResourceBindingRecord => record !== null);
}

export function updateExternalResourceBindingStatusSync(input: {
  workspaceId?: string;
  bindingId: string;
  status: ExternalBindingStatus;
}): ExternalResourceBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_resource_binding
     SET status = ?,
         updated_at = ?,
         archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE NULL END
     WHERE workspace_id = ? AND id = ?`,
  ).run(input.status, now, input.status, now, workspaceId, input.bindingId.trim());

  if (result.changes === 0) {
    throw new Error("External resource binding does not exist.");
  }
  return requireExternalResourceBinding({ workspaceId, bindingId: input.bindingId });
}


export type {
  ExternalResourceBindingDofeAgentType,
  ExternalResourceBindingProviderType,
  ExternalResourceBindingRecord,
} from "../types.ts";
