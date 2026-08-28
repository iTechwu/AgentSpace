import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  selectExternalMessageMappingSql,
  mapExternalMessageMappingRecord,
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

export function createExternalMessageMappingSync(input: {
  workspaceId?: string;
  integrationId: string;
  channelBindingId?: string;
  direction: ExternalMessageDirection;
  externalMessageId: string;
  externalThreadId?: string;
  externalSenderId?: string;
  externalEventId?: string;
  dofeAgentMessageId?: string;
  taskQueueId?: string;
  routerSessionId?: string;
  metadataJson?: JsonInput;
}): ExternalMessageMappingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External message mapping integration id is required.");
  const externalMessageId = normalizeRequiredText(input.externalMessageId, "External message id is required.");
  const id = `external-message-mapping-${randomLikeId()}`;
  const now = new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_message_mapping (
       id,
       workspace_id,
       integration_id,
       channel_binding_id,
       direction,
       external_message_id,
       external_thread_id,
       external_sender_id,
       external_event_id,
       dofe_agent_message_id,
       task_queue_id,
       router_session_id,
       metadata_json,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration_id, external_message_id)
     DO UPDATE SET
       channel_binding_id = COALESCE(EXCLUDED.channel_binding_id, external_message_mapping.channel_binding_id),
       external_thread_id = COALESCE(EXCLUDED.external_thread_id, external_message_mapping.external_thread_id),
       external_sender_id = COALESCE(EXCLUDED.external_sender_id, external_message_mapping.external_sender_id),
       external_event_id = COALESCE(EXCLUDED.external_event_id, external_message_mapping.external_event_id),
       dofe_agent_message_id = COALESCE(EXCLUDED.dofe_agent_message_id, external_message_mapping.dofe_agent_message_id),
       task_queue_id = COALESCE(EXCLUDED.task_queue_id, external_message_mapping.task_queue_id),
       router_session_id = COALESCE(EXCLUDED.router_session_id, external_message_mapping.router_session_id),
       metadata_json = EXCLUDED.metadata_json`,
  ).run(
    id,
    workspaceId,
    integrationId,
    normalizeOptionalText(input.channelBindingId),
    input.direction,
    externalMessageId,
    normalizeOptionalText(input.externalThreadId),
    normalizeOptionalText(input.externalSenderId),
    normalizeOptionalText(input.externalEventId),
    normalizeOptionalText(input.dofeAgentMessageId),
    normalizeOptionalText(input.taskQueueId),
    normalizeOptionalText(input.routerSessionId),
    normalizeJsonInput(input.metadataJson, DEFAULT_JSON_OBJECT),
    now,
  );

  const record = readExternalMessageMappingByExternalMessageSync({ workspaceId, integrationId, externalMessageId });
  if (!record) {
    throw new Error("External message mapping could not be read back.");
  }
  return record;
}

export function readExternalMessageMappingByExternalMessageSync(input: {
  workspaceId?: string;
  integrationId: string;
  externalMessageId: string;
}): ExternalMessageMappingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalMessageMappingSql()}
     WHERE workspace_id = ? AND integration_id = ? AND external_message_id = ?`,
  ).get(workspaceId, input.integrationId.trim(), input.externalMessageId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalMessageMappingRecord(row) : null;
}

export function readExternalMessageMappingByDofeAgentMessageSync(input: {
  workspaceId?: string;
  integrationId?: string;
  dofeAgentMessageId: string;
  direction?: ExternalMessageDirection;
}): ExternalMessageMappingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?", "dofe_agent_message_id = ?"];
  const params: unknown[] = [workspaceId, input.dofeAgentMessageId.trim()];
  if (input.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(input.integrationId.trim());
  }
  if (input.direction) {
    where.push("direction = ?");
    params.push(input.direction);
  }

  const row = getDatabase().prepare(
    `${selectExternalMessageMappingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;

  return row ? mapExternalMessageMappingRecord(row) : null;
}

export function listExternalMessageMappingsSync(options: {
  workspaceId?: string;
  integrationId?: string;
  direction?: ExternalMessageDirection;
  limit?: number;
} = {}): ExternalMessageMappingRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(options.integrationId.trim());
  }
  if (options.direction) {
    where.push("direction = ?");
    params.push(options.direction);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${selectExternalMessageMappingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalMessageMappingRecord).filter((record): record is ExternalMessageMappingRecord => record !== null);
}


export type { ExternalMessageDirection, ExternalMessageMappingRecord } from "../types.ts";
