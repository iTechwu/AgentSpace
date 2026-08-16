// external-integrations 私有共享层（3.2-4 拆分）：SELECT 片段、行映射、
// require/assert 守卫与规范化工具，仅供 integrations/ 域内模块使用。
// require* 守卫依赖域模块的 read* 函数（与 external-integrations.ts 存在
// 循环引用；双方均为函数声明、运行期才求值，ESM live binding 下安全）。
import { createHash } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  readExternalDataOperationRunSync,
  readExternalIntegrationSync,
  readExternalMessageOutboxSync,
  readExternalUserBindingByIdSync,
} from "./external-integrations.ts";
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

export type JsonInput = string | Record<string, unknown> | unknown[] | undefined;

export const DEFAULT_JSON_OBJECT = "{}";
export const DEFAULT_JSON_ARRAY = "[]";


export function updateExternalMessageOutboxTerminalStatus(input: {
  workspaceId?: string;
  outboxId: string;
  status: "sent" | "cancelled";
  sentAt?: string;
}): ExternalMessageOutboxRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_message_outbox
     SET status = ?,
         locked_at = NULL,
         locked_by = NULL,
         sent_at = ?,
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(input.status, normalizeOptionalText(input.sentAt), now, workspaceId, input.outboxId.trim());

  if (result.changes === 0) {
    throw new Error("External message outbox item does not exist.");
  }
  return requireExternalMessageOutbox({ workspaceId, outboxId: input.outboxId });
}

export function requireExternalIntegration(input: { workspaceId: string; integrationId: string }): ExternalIntegrationRecord {
  const record = readExternalIntegrationSync(input);
  if (!record) {
    throw new Error("External integration could not be read back.");
  }
  return record;
}

export function assertExternalIntegrationAppTenantUnique(input: {
  workspaceId: string;
  provider: ExternalIntegrationProvider;
  appId: string | null;
  tenantKey: string | null;
  excludeIntegrationId?: string;
}): void {
  if (!input.appId) {
    return;
  }
  const params: unknown[] = [
    input.workspaceId,
    input.provider,
    input.appId,
    input.tenantKey,
  ];
  const excludeClause = input.excludeIntegrationId
    ? "AND id <> ?"
    : "";
  if (input.excludeIntegrationId) {
    params.push(input.excludeIntegrationId);
  }
  const row = getDatabase().prepare(
    `${selectExternalIntegrationSql()}
     WHERE workspace_id = ?
       AND provider = ?
       AND app_id = ?
       AND COALESCE(tenant_key, '') = COALESCE(?, '')
       ${excludeClause}
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  if (row) {
    throw new Error("External integration app and tenant are already connected.");
  }
}

export function assertExternalIntegrationAgentUnique(input: {
  workspaceId: string;
  provider: ExternalIntegrationProvider;
  agentId: string | null;
  excludeIntegrationId?: string;
}): void {
  if (!input.agentId) {
    return;
  }
  const params: unknown[] = [
    input.workspaceId,
    input.provider,
    input.agentId,
  ];
  const excludeClause = input.excludeIntegrationId
    ? "AND id <> ?"
    : "";
  if (input.excludeIntegrationId) {
    params.push(input.excludeIntegrationId);
  }
  const row = getDatabase().prepare(
    `${selectExternalIntegrationSql()}
     WHERE workspace_id = ?
       AND provider = ?
       AND agent_id = ?
       AND status <> 'disabled'
       ${excludeClause}
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  if (row) {
    throw new Error("External integration agent is already connected.");
  }
}

export function requireExternalUserBinding(input: { workspaceId: string; bindingId: string }): ExternalUserBindingRecord {
  const record = readExternalUserBindingByIdSync(input);
  if (!record) {
    throw new Error("External user binding could not be read back.");
  }
  return record;
}

export function requireExternalChannelBinding(input: { workspaceId: string; bindingId: string }): ExternalChannelBindingRecord {
  const row = getDatabase().prepare(
    `${selectExternalChannelBindingSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(input.workspaceId, input.bindingId.trim()) as Record<string, unknown> | undefined;
  const record = row ? mapExternalChannelBindingRecord(row) : null;
  if (!record) {
    throw new Error("External channel binding could not be read back.");
  }
  return record;
}

export function requireExternalResourceBinding(input: { workspaceId: string; bindingId: string }): ExternalResourceBindingRecord {
  const row = getDatabase().prepare(
    `${selectExternalResourceBindingSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(input.workspaceId, input.bindingId.trim()) as Record<string, unknown> | undefined;
  const record = row ? mapExternalResourceBindingRecord(row) : null;
  if (!record) {
    throw new Error("External resource binding could not be read back.");
  }
  return record;
}

export function requireExternalMessageOutbox(input: { workspaceId: string; outboxId: string }): ExternalMessageOutboxRecord {
  const record = readExternalMessageOutboxSync(input);
  if (!record) {
    throw new Error("External message outbox item could not be read back.");
  }
  return record;
}

export function requireExternalDataOperationRun(input: { workspaceId: string; runId: string }): ExternalDataOperationRunRecord {
  const record = readExternalDataOperationRunSync(input);
  if (!record) {
    throw new Error("External data operation run could not be read back.");
  }
  return record;
}

export function selectExternalIntegrationSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    provider,
    display_name AS "displayName",
    status,
    transport_mode AS "transportMode",
    agent_id AS "agentId",
    app_id AS "appId",
    tenant_key AS "tenantKey",
    encrypted_credentials_json AS "encryptedCredentialsJson",
    config_json AS "configJson",
    capabilities_json AS "capabilitiesJson",
    scopes_json AS "scopesJson",
    created_by_user_id AS "createdByUserId",
    updated_by_user_id AS "updatedByUserId",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    disabled_at AS "disabledAt",
    last_health_status AS "lastHealthStatus",
    last_health_checked_at AS "lastHealthCheckedAt",
    last_error AS "lastError"
   FROM external_integration`;
}

export function selectExternalUserBindingSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    user_id AS "userId",
    external_user_id AS "externalUserId",
    external_union_id AS "externalUnionId",
    external_open_id AS "externalOpenId",
    external_email AS "externalEmail",
    display_name AS "displayName",
    status,
    metadata_json AS "metadataJson",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    last_seen_at AS "lastSeenAt"
   FROM external_user_binding`;
}

export function selectExternalChannelBindingSql(alias = "external_channel_binding"): string {
  return `SELECT
    ${alias}.id,
    ${alias}.workspace_id AS "workspaceId",
    ${alias}.integration_id AS "integrationId",
    ${alias}.channel_name AS "channelName",
    ${alias}.external_chat_id AS "externalChatId",
    ${alias}.external_chat_type AS "externalChatType",
    ${alias}.external_chat_name AS "externalChatName",
    ${alias}.status,
    ${alias}.sync_mode AS "syncMode",
    ${alias}.metadata_json AS "metadataJson",
    ${alias}.created_by_user_id AS "createdByUserId",
    ${alias}.created_at AS "createdAt",
    ${alias}.updated_at AS "updatedAt",
    ${alias}.disabled_at AS "disabledAt"
   FROM external_channel_binding ${alias}`;
}

export function selectExternalResourceBindingSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    provider_resource_type AS "providerResourceType",
    provider_resource_token AS "providerResourceToken",
    provider_resource_url AS "providerResourceUrl",
    dofe_agent_resource_type AS "dofeAgentResourceType",
    dofe_agent_resource_id AS "dofeAgentResourceId",
    channel_name AS "channelName",
    display_name AS "displayName",
    status,
    permissions_json AS "permissionsJson",
    metadata_json AS "metadataJson",
    created_by_user_id AS "createdByUserId",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    archived_at AS "archivedAt"
   FROM external_resource_binding`;
}

export function selectExternalMessageMappingSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    channel_binding_id AS "channelBindingId",
    direction,
    external_message_id AS "externalMessageId",
    external_thread_id AS "externalThreadId",
    external_sender_id AS "externalSenderId",
    external_event_id AS "externalEventId",
    dofe_agent_message_id AS "dofeAgentMessageId",
    task_queue_id AS "taskQueueId",
    router_session_id AS "routerSessionId",
    metadata_json AS "metadataJson",
    created_at AS "createdAt"
   FROM external_message_mapping`;
}

export function selectExternalThreadBindingSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    channel_binding_id AS "channelBindingId",
    provider,
    tenant_key AS "tenantKey",
    external_chat_id AS "externalChatId",
    external_thread_id AS "externalThreadId",
    channel_name AS "channelName",
    agent_id AS "agentId",
    task_queue_id AS "taskQueueId",
    dofe_agent_message_id AS "dofeAgentMessageId",
    status,
    metadata_json AS "metadataJson",
    last_message_at AS "lastMessageAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
   FROM external_thread_binding`;
}

export function selectExternalMessageOutboxSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    channel_binding_id AS "channelBindingId",
    target_external_chat_id AS "targetExternalChatId",
    target_external_thread_id AS "targetExternalThreadId",
    dofe_agent_message_id AS "dofeAgentMessageId",
    payload_json AS "payloadJson",
    metadata_json AS "metadataJson",
    status,
    attempts,
    next_attempt_at AS "nextAttemptAt",
    locked_at AS "lockedAt",
    locked_by AS "lockedBy",
    last_error AS "lastError",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    sent_at AS "sentAt"
   FROM external_message_outbox`;
}

export function selectExternalDataOperationRunSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    resource_binding_id AS "resourceBindingId",
    operation_type AS "operationType",
    provider_resource_type AS "providerResourceType",
    provider_resource_token AS "providerResourceToken",
    actor_type AS "actorType",
    actor_id AS "actorId",
    status,
    request_json AS "requestJson",
    result_json AS "resultJson",
    error_code AS "errorCode",
    error_message AS "errorMessage",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
   FROM external_data_operation_run`;
}

export function selectExternalIntegrationEventSql(): string {
  return `SELECT
    id,
    workspace_id AS "workspaceId",
    integration_id AS "integrationId",
    provider,
    external_event_id AS "externalEventId",
    event_type AS "eventType",
    status,
    payload_json AS "payloadJson",
    error_message AS "errorMessage",
    received_at AS "receivedAt",
    processed_at AS "processedAt"
   FROM external_integration_event`;
}

export function mapExternalIntegrationRecord(value: Record<string, unknown>): ExternalIntegrationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.displayName !== "string" ||
    !isExternalIntegrationStatus(value.status) ||
    !isExternalIntegrationTransportMode(value.transportMode) ||
    typeof value.encryptedCredentialsJson !== "string" ||
    typeof value.configJson !== "string" ||
    typeof value.capabilitiesJson !== "string" ||
    typeof value.scopesJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    provider: value.provider,
    displayName: value.displayName,
    status: value.status,
    transportMode: value.transportMode,
    agentId: asOptionalString(value.agentId),
    appId: asOptionalString(value.appId),
    tenantKey: asOptionalString(value.tenantKey),
    encryptedCredentialsJson: value.encryptedCredentialsJson,
    configJson: value.configJson,
    capabilitiesJson: value.capabilitiesJson,
    scopesJson: value.scopesJson,
    createdByUserId: asOptionalString(value.createdByUserId),
    updatedByUserId: asOptionalString(value.updatedByUserId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    disabledAt: asOptionalString(value.disabledAt),
    lastHealthStatus: isExternalIntegrationHealthStatus(value.lastHealthStatus) ? value.lastHealthStatus : undefined,
    lastHealthCheckedAt: asOptionalString(value.lastHealthCheckedAt),
    lastError: asOptionalString(value.lastError),
  };
}

export function mapExternalUserBindingRecord(value: Record<string, unknown>): ExternalUserBindingRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.externalUserId !== "string" ||
    !isExternalBindingStatus(value.status) ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    userId: value.userId,
    externalUserId: value.externalUserId,
    externalUnionId: asOptionalString(value.externalUnionId),
    externalOpenId: asOptionalString(value.externalOpenId),
    externalEmail: asOptionalString(value.externalEmail),
    displayName: asOptionalString(value.displayName),
    status: value.status,
    metadataJson: value.metadataJson,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastSeenAt: asOptionalString(value.lastSeenAt),
  };
}

export function mapExternalChannelBindingRecord(value: Record<string, unknown>): ExternalChannelBindingRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.channelName !== "string" ||
    typeof value.externalChatId !== "string" ||
    !isExternalBindingStatus(value.status) ||
    !isExternalChannelBindingSyncMode(value.syncMode) ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    channelName: value.channelName,
    externalChatId: value.externalChatId,
    externalChatType: asOptionalString(value.externalChatType),
    externalChatName: asOptionalString(value.externalChatName),
    status: value.status,
    syncMode: value.syncMode,
    metadataJson: value.metadataJson,
    createdByUserId: asOptionalString(value.createdByUserId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    disabledAt: asOptionalString(value.disabledAt),
  };
}

export function mapExternalResourceBindingRecord(value: Record<string, unknown>): ExternalResourceBindingRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.providerResourceType !== "string" ||
    typeof value.providerResourceToken !== "string" ||
    typeof value.dofeAgentResourceType !== "string" ||
    typeof value.dofeAgentResourceId !== "string" ||
    !isExternalBindingStatus(value.status) ||
    typeof value.permissionsJson !== "string" ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    providerResourceType: value.providerResourceType,
    providerResourceToken: value.providerResourceToken,
    providerResourceUrl: asOptionalString(value.providerResourceUrl),
    dofeAgentResourceType: value.dofeAgentResourceType,
    dofeAgentResourceId: value.dofeAgentResourceId,
    channelName: asOptionalString(value.channelName),
    displayName: asOptionalString(value.displayName),
    status: value.status,
    permissionsJson: value.permissionsJson,
    metadataJson: value.metadataJson,
    createdByUserId: asOptionalString(value.createdByUserId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: asOptionalString(value.archivedAt),
  };
}

export function mapExternalMessageMappingRecord(value: Record<string, unknown>): ExternalMessageMappingRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    !isExternalMessageDirection(value.direction) ||
    typeof value.externalMessageId !== "string" ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    channelBindingId: asOptionalString(value.channelBindingId),
    direction: value.direction,
    externalMessageId: value.externalMessageId,
    externalThreadId: asOptionalString(value.externalThreadId),
    externalSenderId: asOptionalString(value.externalSenderId),
    externalEventId: asOptionalString(value.externalEventId),
    dofeAgentMessageId: asOptionalString(value.dofeAgentMessageId),
    taskQueueId: asOptionalString(value.taskQueueId),
    routerSessionId: asOptionalString(value.routerSessionId),
    metadataJson: value.metadataJson,
    createdAt: value.createdAt,
  };
}

export function mapExternalThreadBindingRecord(value: Record<string, unknown>): ExternalThreadBindingRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.externalChatId !== "string" ||
    typeof value.externalThreadId !== "string" ||
    typeof value.channelName !== "string" ||
    typeof value.agentId !== "string" ||
    !isExternalThreadBindingStatus(value.status) ||
    typeof value.metadataJson !== "string" ||
    typeof value.lastMessageAt !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    channelBindingId: asOptionalString(value.channelBindingId),
    provider: value.provider,
    tenantKey: asOptionalString(value.tenantKey),
    externalChatId: value.externalChatId,
    externalThreadId: value.externalThreadId,
    channelName: value.channelName,
    agentId: value.agentId,
    taskQueueId: asOptionalString(value.taskQueueId),
    dofeAgentMessageId: asOptionalString(value.dofeAgentMessageId),
    status: value.status,
    metadataJson: value.metadataJson,
    lastMessageAt: value.lastMessageAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function mapExternalMessageOutboxRecord(value: Record<string, unknown>): ExternalMessageOutboxRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.targetExternalChatId !== "string" ||
    typeof value.payloadJson !== "string" ||
    typeof value.metadataJson !== "string" ||
    !isExternalMessageOutboxStatus(value.status) ||
    typeof value.attempts !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    channelBindingId: asOptionalString(value.channelBindingId),
    targetExternalChatId: value.targetExternalChatId,
    targetExternalThreadId: asOptionalString(value.targetExternalThreadId),
    dofeAgentMessageId: asOptionalString(value.dofeAgentMessageId),
    payloadJson: value.payloadJson,
    metadataJson: value.metadataJson,
    status: value.status,
    attempts: value.attempts,
    nextAttemptAt: asOptionalString(value.nextAttemptAt),
    lockedAt: asOptionalString(value.lockedAt),
    lockedBy: asOptionalString(value.lockedBy),
    lastError: asOptionalString(value.lastError),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    sentAt: asOptionalString(value.sentAt),
  };
}

export function mapExternalDataOperationRunRecord(value: Record<string, unknown>): ExternalDataOperationRunRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.integrationId !== "string" ||
    typeof value.operationType !== "string" ||
    typeof value.providerResourceType !== "string" ||
    typeof value.providerResourceToken !== "string" ||
    !isExternalDataOperationActorType(value.actorType) ||
    !isExternalDataOperationRunStatus(value.status) ||
    typeof value.requestJson !== "string" ||
    typeof value.resultJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: value.integrationId,
    resourceBindingId: asOptionalString(value.resourceBindingId),
    operationType: value.operationType,
    providerResourceType: value.providerResourceType,
    providerResourceToken: value.providerResourceToken,
    actorType: value.actorType,
    actorId: asOptionalString(value.actorId),
    status: value.status,
    requestJson: value.requestJson,
    resultJson: value.resultJson,
    errorCode: asOptionalString(value.errorCode),
    errorMessage: asOptionalString(value.errorMessage),
    startedAt: asOptionalString(value.startedAt),
    finishedAt: asOptionalString(value.finishedAt),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function mapExternalIntegrationEventRecord(value: Record<string, unknown>): ExternalIntegrationEventRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.externalEventId !== "string" ||
    typeof value.eventType !== "string" ||
    !isExternalIntegrationEventStatus(value.status) ||
    typeof value.payloadJson !== "string" ||
    typeof value.receivedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    integrationId: asOptionalString(value.integrationId),
    provider: value.provider,
    externalEventId: value.externalEventId,
    eventType: value.eventType,
    status: value.status,
    payloadJson: value.payloadJson,
    errorMessage: asOptionalString(value.errorMessage),
    receivedAt: value.receivedAt,
    processedAt: asOptionalString(value.processedAt),
  };
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

export function normalizeOptionalText(value: string | undefined | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeThreadTenantKey(value: string | undefined | null): string {
  return normalizeOptionalText(value) ?? "";
}

export function normalizeOptionalEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function normalizeJsonInput(value: JsonInput, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
  }
  if (value === undefined) {
    return fallback;
  }
  return JSON.stringify(value);
}

export function buildExternalMessageOutboxMetadataJson(input: {
  workspaceId: string;
  integrationId: string;
  metadataJson?: JsonInput;
}): string {
  const metadata = readJsonInputRecord(input.metadataJson);
  const integration = readExternalIntegrationSync({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
  });
  const provider = normalizeOptionalText(integration?.provider);
  const agentId = normalizeOptionalText(integration?.agentId);
  if (provider && !normalizeOptionalText(readRecordString(metadata.provider))) {
    metadata.provider = provider;
  }
  if (agentId && !normalizeOptionalText(readRecordString(metadata.agentId))) {
    metadata.agentId = agentId;
  }
  if (agentId && !normalizeOptionalText(readRecordString(metadata.botBindingId))) {
    metadata.botBindingId = input.integrationId;
  }
  return normalizeJsonInput(metadata, DEFAULT_JSON_OBJECT);
}

export function readJsonInputRecord(value: JsonInput): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return isRecord(parsed) ? { ...parsed } : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? { ...value } : {};
}

export function readRecordString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isExternalIntegrationStatus(value: unknown): value is ExternalIntegrationStatus {
  return value === "active" || value === "disabled" || value === "error";
}

export function isExternalIntegrationTransportMode(value: unknown): value is ExternalIntegrationTransportMode {
  return value === "http_webhook" || value === "websocket_worker";
}

export function isExternalIntegrationHealthStatus(value: unknown): value is ExternalIntegrationHealthStatus {
  return value === "unknown" || value === "healthy" || value === "degraded" || value === "error";
}

export function isExternalBindingStatus(value: unknown): value is ExternalBindingStatus {
  return value === "active" || value === "disabled" || value === "archived";
}

export function isExternalChannelBindingSyncMode(value: unknown): value is ExternalChannelBindingSyncMode {
  return value === "mirror" || value === "ingest_only" || value === "send_only";
}

export function isExternalMessageDirection(value: unknown): value is ExternalMessageDirection {
  return value === "inbound" || value === "outbound";
}

export function isExternalMessageOutboxStatus(value: unknown): value is ExternalMessageOutboxStatus {
  return value === "pending" || value === "locked" || value === "sent" || value === "failed" || value === "cancelled";
}

export function isExternalThreadBindingStatus(value: unknown): value is ExternalThreadBindingStatus {
  return value === "active" || value === "closed" || value === "archived";
}

export function isExternalDataOperationRunStatus(value: unknown): value is ExternalDataOperationRunStatus {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

export function isExternalDataOperationActorType(value: unknown): value is ExternalDataOperationActorType {
  return value === "user" || value === "agent" || value === "system";
}

export function isExternalIntegrationEventStatus(value: unknown): value is ExternalIntegrationEventStatus {
  return value === "received" || value === "processed" || value === "ignored" || value === "failed";
}
