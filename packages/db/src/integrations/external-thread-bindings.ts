import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  selectExternalThreadBindingSql,
  mapExternalThreadBindingRecord,
  normalizeRequiredText,
  normalizeOptionalText,
  normalizeThreadTenantKey,
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

export function upsertExternalThreadBindingSync(input: {
  workspaceId?: string;
  integrationId: string;
  channelBindingId?: string;
  provider: ExternalIntegrationProvider;
  tenantKey?: string;
  externalChatId: string;
  externalThreadId: string;
  channelName: string;
  agentId: string;
  taskQueueId?: string;
  dofeAgentMessageId?: string;
  status?: ExternalThreadBindingStatus;
  metadataJson?: JsonInput;
  lastMessageAt?: string;
}): ExternalThreadBindingRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External thread binding integration id is required.");
  const provider = normalizeRequiredText(input.provider, "External thread binding provider is required.");
  const externalChatId = normalizeRequiredText(input.externalChatId, "External thread binding external chat id is required.");
  const externalThreadId = normalizeRequiredText(input.externalThreadId, "External thread binding external thread id is required.");
  const channelName = normalizeRequiredText(input.channelName, "External thread binding channel name is required.");
  const agentId = normalizeRequiredText(input.agentId, "External thread binding agent id is required.");
  const tenantKey = normalizeThreadTenantKey(input.tenantKey);
  const id = `external-thread-binding-${randomLikeId()}`;
  const now = new Date().toISOString();
  const lastMessageAt = normalizeOptionalText(input.lastMessageAt) ?? now;

  getDatabase().prepare(
    `INSERT INTO external_thread_binding (
       id,
       workspace_id,
       integration_id,
       channel_binding_id,
       provider,
       tenant_key,
       external_chat_id,
       external_thread_id,
       channel_name,
       agent_id,
       task_queue_id,
       dofe_agent_message_id,
       status,
       metadata_json,
       last_message_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, provider, tenant_key, external_chat_id, external_thread_id, agent_id)
     DO UPDATE SET
       integration_id = EXCLUDED.integration_id,
       channel_binding_id = COALESCE(EXCLUDED.channel_binding_id, external_thread_binding.channel_binding_id),
       channel_name = EXCLUDED.channel_name,
       task_queue_id = COALESCE(EXCLUDED.task_queue_id, external_thread_binding.task_queue_id),
       dofe_agent_message_id = COALESCE(EXCLUDED.dofe_agent_message_id, external_thread_binding.dofe_agent_message_id),
       status = EXCLUDED.status,
       metadata_json = EXCLUDED.metadata_json,
       last_message_at = EXCLUDED.last_message_at,
       updated_at = EXCLUDED.updated_at`,
  ).run(
    id,
    workspaceId,
    integrationId,
    normalizeOptionalText(input.channelBindingId),
    provider,
    tenantKey,
    externalChatId,
    externalThreadId,
    channelName,
    agentId,
    normalizeOptionalText(input.taskQueueId),
    normalizeOptionalText(input.dofeAgentMessageId),
    input.status ?? "active",
    normalizeJsonInput(input.metadataJson, DEFAULT_JSON_OBJECT),
    lastMessageAt,
    now,
    now,
  );

  const record = readExternalThreadBindingSync({
    workspaceId,
    provider,
    tenantKey,
    externalChatId,
    externalThreadId,
    agentId,
  });
  if (!record) {
    throw new Error("External thread binding could not be read back.");
  }
  return record;
}

export function readExternalThreadBindingByIdSync(input: {
  workspaceId?: string;
  bindingId: string;
}): ExternalThreadBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalThreadBindingSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, input.bindingId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalThreadBindingRecord(row) : null;
}

export function readExternalThreadBindingSync(input: {
  workspaceId?: string;
  provider: ExternalIntegrationProvider;
  externalChatId: string;
  externalThreadId: string;
  agentId: string;
  tenantKey?: string;
  status?: ExternalThreadBindingStatus;
}): ExternalThreadBindingRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = [
    "workspace_id = ?",
    "provider = ?",
    "tenant_key = ?",
    "external_chat_id = ?",
    "external_thread_id = ?",
    "agent_id = ?",
  ];
  const params: unknown[] = [
    workspaceId,
    normalizeRequiredText(input.provider, "External thread binding provider is required."),
    normalizeThreadTenantKey(input.tenantKey),
    normalizeRequiredText(input.externalChatId, "External thread binding external chat id is required."),
    normalizeRequiredText(input.externalThreadId, "External thread binding external thread id is required."),
    normalizeRequiredText(input.agentId, "External thread binding agent id is required."),
  ];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  const row = getDatabase().prepare(
    `${selectExternalThreadBindingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;

  return row ? mapExternalThreadBindingRecord(row) : null;
}

export function listExternalThreadBindingsSync(options: {
  workspaceId?: string;
  integrationId?: string;
  provider?: ExternalIntegrationProvider;
  externalChatId?: string;
  externalThreadId?: string;
  agentId?: string;
  tenantKey?: string;
  status?: ExternalThreadBindingStatus;
  limit?: number;
} = {}): ExternalThreadBindingRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(options.integrationId.trim());
  }
  if (options.provider?.trim()) {
    where.push("provider = ?");
    params.push(options.provider.trim());
  }
  if (options.tenantKey !== undefined) {
    where.push("tenant_key = ?");
    params.push(normalizeThreadTenantKey(options.tenantKey));
  }
  if (options.externalChatId?.trim()) {
    where.push("external_chat_id = ?");
    params.push(options.externalChatId.trim());
  }
  if (options.externalThreadId?.trim()) {
    where.push("external_thread_id = ?");
    params.push(options.externalThreadId.trim());
  }
  if (options.agentId?.trim()) {
    where.push("agent_id = ?");
    params.push(options.agentId.trim());
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${selectExternalThreadBindingSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY last_message_at DESC, updated_at DESC, id DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalThreadBindingRecord).filter((record): record is ExternalThreadBindingRecord => record !== null);
}


export type { ExternalThreadBindingRecord, ExternalThreadBindingStatus } from "../types.ts";
