// external-integrations 核心域：外部集成本体 CRUD / 凭据 / 健康 / 事件。
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  DEFAULT_JSON_ARRAY,
  requireExternalIntegration,
  assertExternalIntegrationAppTenantUnique,
  assertExternalIntegrationAgentUnique,
  selectExternalIntegrationSql,
  selectExternalIntegrationEventSql,
  mapExternalIntegrationRecord,
  mapExternalIntegrationEventRecord,
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

export function createExternalIntegrationSync(input: {
  workspaceId?: string;
  provider: ExternalIntegrationProvider;
  displayName: string;
  transportMode: ExternalIntegrationTransportMode;
  agentId?: string;
  appId?: string;
  tenantKey?: string;
  encryptedCredentialsJson?: JsonInput;
  configJson?: JsonInput;
  capabilitiesJson?: JsonInput;
  scopesJson?: JsonInput;
  createdByUserId?: string;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const provider = normalizeRequiredText(input.provider, "External integration provider is required.");
  const displayName = normalizeRequiredText(input.displayName, "External integration display name is required.");
  const agentId = normalizeOptionalText(input.agentId);
  const appId = normalizeOptionalText(input.appId);
  const tenantKey = normalizeOptionalText(input.tenantKey);
  assertExternalIntegrationAppTenantUnique({
    workspaceId,
    provider,
    appId,
    tenantKey,
  });
  assertExternalIntegrationAgentUnique({
    workspaceId,
    provider,
    agentId,
  });
  const id = `external-integration-${randomLikeId()}`;
  const now = new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_integration (
       id,
       workspace_id,
       provider,
       display_name,
       status,
       transport_mode,
       agent_id,
       app_id,
       tenant_key,
       encrypted_credentials_json,
       config_json,
       capabilities_json,
       scopes_json,
       created_by_user_id,
       updated_by_user_id,
       created_at,
       updated_at,
       last_health_status
     ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`,
  ).run(
    id,
    workspaceId,
    provider,
    displayName,
    input.transportMode,
    agentId,
    appId,
    tenantKey,
    normalizeJsonInput(input.encryptedCredentialsJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.configJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.capabilitiesJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.scopesJson, DEFAULT_JSON_ARRAY),
    normalizeOptionalText(input.createdByUserId),
    normalizeOptionalText(input.createdByUserId),
    now,
    now,
  );

  const record = readExternalIntegrationSync({ workspaceId, integrationId: id });
  if (!record) {
    throw new Error("External integration could not be read back.");
  }
  return record;
}

export function readExternalIntegrationSync(input: {
  workspaceId?: string;
  integrationId: string;
}): ExternalIntegrationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalIntegrationSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, input.integrationId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalIntegrationRecord(row) : null;
}

export function listExternalIntegrationsSync(options: {
  workspaceId?: string;
  provider?: ExternalIntegrationProvider;
  agentId?: string;
  scope?: "all" | "workspace" | "agent";
  includeDisabled?: boolean;
} = {}): ExternalIntegrationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider);
  }
  if (options.agentId) {
    where.push("agent_id = ?");
    params.push(options.agentId.trim());
  } else if (options.scope === "workspace") {
    where.push("agent_id IS NULL");
  } else if (options.scope === "agent") {
    where.push("agent_id IS NOT NULL");
  }
  if (!options.includeDisabled) {
    where.push("status <> 'disabled'");
  }

  const rows = getDatabase().prepare(
    `${selectExternalIntegrationSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalIntegrationRecord).filter((record): record is ExternalIntegrationRecord => record !== null);
}

export function readExternalIntegrationByAgentSync(input: {
  workspaceId?: string;
  provider: ExternalIntegrationProvider;
  agentId: string;
  includeDisabled?: boolean;
}): ExternalIntegrationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const agentId = normalizeRequiredText(input.agentId, "External integration agent id is required.");
  const where = [
    "workspace_id = ?",
    "provider = ?",
    "agent_id = ?",
  ];
  const params: unknown[] = [workspaceId, input.provider, agentId];
  if (!input.includeDisabled) {
    where.push("status <> 'disabled'");
  }
  const row = getDatabase().prepare(
    `${selectExternalIntegrationSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;

  return row ? mapExternalIntegrationRecord(row) : null;
}

export function deleteExternalIntegrationSync(input: {
  workspaceId?: string;
  integrationId: string;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const record = requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
  getDatabase().prepare(
    `DELETE FROM external_integration
     WHERE workspace_id = ? AND id = ?`,
  ).run(workspaceId, input.integrationId.trim());
  return record;
}

export function updateExternalIntegrationStatusSync(input: {
  workspaceId?: string;
  integrationId: string;
  status: ExternalIntegrationStatus;
  updatedByUserId?: string;
  lastError?: string;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_integration
     SET status = ?,
         updated_by_user_id = ?,
         updated_at = ?,
         disabled_at = CASE WHEN ? = 'disabled' THEN COALESCE(disabled_at, ?) ELSE NULL END,
         last_error = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(
    input.status,
    normalizeOptionalText(input.updatedByUserId),
    now,
    input.status,
    now,
    normalizeOptionalText(input.lastError),
    workspaceId,
    input.integrationId.trim(),
  );

  if (result.changes === 0) {
    throw new Error("External integration does not exist.");
  }
  return requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
}

export function updateExternalIntegrationHealthSync(input: {
  workspaceId?: string;
  integrationId: string;
  lastHealthStatus: ExternalIntegrationHealthStatus;
  lastError?: string;
  configJson?: JsonInput;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = input.configJson === undefined
    ? getDatabase().prepare(
      `UPDATE external_integration
       SET last_health_status = ?,
           last_health_checked_at = ?,
           last_error = ?,
           updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(
      input.lastHealthStatus,
      now,
      normalizeOptionalText(input.lastError),
      now,
      workspaceId,
      input.integrationId.trim(),
    )
    : getDatabase().prepare(
      `UPDATE external_integration
       SET last_health_status = ?,
           last_health_checked_at = ?,
           last_error = ?,
           config_json = ?,
           updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(
      input.lastHealthStatus,
      now,
      normalizeOptionalText(input.lastError),
      normalizeJsonInput(input.configJson, DEFAULT_JSON_OBJECT),
      now,
      workspaceId,
      input.integrationId.trim(),
    );

  if (result.changes === 0) {
    throw new Error("External integration does not exist.");
  }
  return requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
}

export function updateExternalIntegrationCredentialsSync(input: {
  workspaceId?: string;
  integrationId: string;
  appId?: string;
  tenantKey?: string;
  encryptedCredentialsJson: JsonInput;
  updatedByUserId?: string;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integration = requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
  const appId = normalizeOptionalText(input.appId);
  const tenantKey = normalizeOptionalText(input.tenantKey);
  assertExternalIntegrationAppTenantUnique({
    workspaceId,
    provider: integration.provider,
    appId,
    tenantKey,
    excludeIntegrationId: integration.id,
  });
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_integration
     SET app_id = ?,
         tenant_key = ?,
         encrypted_credentials_json = ?,
         updated_by_user_id = ?,
         updated_at = ?,
         last_health_status = 'unknown',
         last_health_checked_at = NULL,
         last_error = NULL
     WHERE workspace_id = ? AND id = ?`,
  ).run(
    appId,
    tenantKey,
    normalizeJsonInput(input.encryptedCredentialsJson, DEFAULT_JSON_OBJECT),
    normalizeOptionalText(input.updatedByUserId),
    now,
    workspaceId,
    input.integrationId.trim(),
  );

  if (result.changes === 0) {
    throw new Error("External integration does not exist.");
  }
  return requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
}

export function reassignDisabledExternalIntegrationSync(input: {
  workspaceId?: string;
  integrationId: string;
  provider: ExternalIntegrationProvider;
  appId: string;
  tenantKey?: string;
  displayName: string;
  transportMode: ExternalIntegrationTransportMode;
  agentId: string;
  encryptedCredentialsJson: JsonInput;
  configJson: JsonInput;
  capabilitiesJson: JsonInput;
  scopesJson: JsonInput;
  updatedByUserId?: string;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integration = requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
  const provider = normalizeRequiredText(input.provider, "External integration provider is required.");
  const appId = normalizeRequiredText(input.appId, "External integration app id is required.");
  const tenantKey = normalizeOptionalText(input.tenantKey);
  const displayName = normalizeRequiredText(input.displayName, "External integration display name is required.");
  const agentId = normalizeRequiredText(input.agentId, "External integration agent id is required.");
  if (integration.status !== "disabled") {
    throw new Error("External integration must be disabled before reassignment.");
  }
  if (integration.provider !== provider || integration.appId !== appId || integration.tenantKey !== tenantKey) {
    throw new Error("External integration does not match the requested app and tenant.");
  }
  assertExternalIntegrationAgentUnique({
    workspaceId,
    provider,
    agentId,
    excludeIntegrationId: integration.id,
  });

  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_integration
     SET display_name = ?,
         status = 'active',
         transport_mode = ?,
         agent_id = ?,
         encrypted_credentials_json = ?,
         config_json = ?,
         capabilities_json = ?,
         scopes_json = ?,
         updated_by_user_id = ?,
         updated_at = ?,
         disabled_at = NULL,
         last_health_status = 'unknown',
         last_health_checked_at = NULL,
         last_error = NULL
     WHERE workspace_id = ? AND id = ? AND status = 'disabled'`,
  ).run(
    displayName,
    input.transportMode,
    agentId,
    normalizeJsonInput(input.encryptedCredentialsJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.configJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.capabilitiesJson, DEFAULT_JSON_OBJECT),
    normalizeJsonInput(input.scopesJson, DEFAULT_JSON_ARRAY),
    normalizeOptionalText(input.updatedByUserId),
    now,
    workspaceId,
    integration.id,
  );

  if (result.changes === 0) {
    throw new Error("External integration was changed before reassignment completed.");
  }
  return requireExternalIntegration({ workspaceId, integrationId: integration.id });
}

export function updateExternalIntegrationConfigSync(input: {
  workspaceId?: string;
  integrationId: string;
  configJson: JsonInput;
  updatedByUserId?: string;
}): ExternalIntegrationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_integration
     SET config_json = ?,
         updated_by_user_id = ?,
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(
    normalizeJsonInput(input.configJson, DEFAULT_JSON_OBJECT),
    normalizeOptionalText(input.updatedByUserId),
    now,
    workspaceId,
    input.integrationId.trim(),
  );

  if (result.changes === 0) {
    throw new Error("External integration does not exist.");
  }
  return requireExternalIntegration({ workspaceId, integrationId: input.integrationId });
}


export function recordExternalIntegrationEventSync(input: {
  workspaceId?: string;
  integrationId?: string;
  provider: ExternalIntegrationProvider;
  externalEventId: string;
  eventType: string;
  status?: ExternalIntegrationEventStatus;
  payloadJson?: JsonInput;
  errorMessage?: string;
  receivedAt?: string;
}): ExternalIntegrationEventRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const provider = normalizeRequiredText(input.provider, "External integration event provider is required.");
  const externalEventId = normalizeRequiredText(input.externalEventId, "External integration event id is required.");
  const id = `external-integration-event-${randomLikeId()}`;
  const receivedAt = input.receivedAt ?? new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_integration_event (
       id,
       workspace_id,
       integration_id,
       provider,
       external_event_id,
       event_type,
       status,
       payload_json,
       error_message,
       received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, provider, external_event_id)
     DO UPDATE SET
       integration_id = COALESCE(EXCLUDED.integration_id, external_integration_event.integration_id),
       event_type = EXCLUDED.event_type,
       status = EXCLUDED.status,
       payload_json = EXCLUDED.payload_json,
       error_message = EXCLUDED.error_message`,
  ).run(
    id,
    workspaceId,
    normalizeOptionalText(input.integrationId),
    provider,
    externalEventId,
    normalizeRequiredText(input.eventType, "External integration event type is required."),
    input.status ?? "received",
    normalizeJsonInput(input.payloadJson, DEFAULT_JSON_OBJECT),
    normalizeOptionalText(input.errorMessage),
    receivedAt,
  );

  const record = readExternalIntegrationEventSync({ workspaceId, provider, externalEventId });
  if (!record) {
    throw new Error("External integration event could not be read back.");
  }
  return record;
}

export function readExternalIntegrationEventSync(input: {
  workspaceId?: string;
  provider: ExternalIntegrationProvider;
  externalEventId: string;
}): ExternalIntegrationEventRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalIntegrationEventSql()}
     WHERE workspace_id = ? AND provider = ? AND external_event_id = ?`,
  ).get(workspaceId, input.provider, input.externalEventId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalIntegrationEventRecord(row) : null;
}

export function listExternalIntegrationEventsSync(options: {
  workspaceId?: string;
  provider?: ExternalIntegrationProvider;
  integrationId?: string;
  status?: ExternalIntegrationEventStatus;
  limit?: number;
} = {}): ExternalIntegrationEventRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider);
  }
  if (options.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(options.integrationId.trim());
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));
  const rows = getDatabase().prepare(
    `${selectExternalIntegrationEventSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY received_at DESC, id DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalIntegrationEventRecord).filter((record): record is ExternalIntegrationEventRecord => record !== null);
}

export function updateExternalIntegrationEventStatusSync(input: {
  workspaceId?: string;
  provider: ExternalIntegrationProvider;
  externalEventId: string;
  status: ExternalIntegrationEventStatus;
  errorMessage?: string;
}): ExternalIntegrationEventRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const processedAt = input.status === "processed" || input.status === "ignored" || input.status === "failed"
    ? new Date().toISOString()
    : null;
  const result = getDatabase().prepare(
    `UPDATE external_integration_event
     SET status = ?,
         error_message = ?,
         processed_at = COALESCE(?, processed_at)
     WHERE workspace_id = ? AND provider = ? AND external_event_id = ?`,
  ).run(
    input.status,
    normalizeOptionalText(input.errorMessage),
    processedAt,
    workspaceId,
    input.provider,
    input.externalEventId.trim(),
  );

  if (result.changes === 0) {
    throw new Error("External integration event does not exist.");
  }
  const event = readExternalIntegrationEventSync(input);
  if (!event) {
    throw new Error("External integration event could not be read back.");
  }
  return event;
}


// 3.2-4 拆分：以下域实现已迁移至 integrations/ 同级域模块，这里保留 re-export 兼容既有导入面。
export {
  listExternalChannelBindingsSync,
  readExternalChannelBindingByExternalChatSync,
  readExternalChannelBindingByProviderChatSync,
  readExternalChannelBindingSync,
  updateExternalChannelBindingStatusSync,
  upsertExternalChannelBindingSync,
} from "./external-channel-bindings.ts";
export {
  createExternalDataOperationRunSync,
  listExternalDataOperationRunsSync,
  readExternalDataOperationRunSync,
  updateExternalDataOperationRunStatusSync,
} from "./external-data-operation-runs.ts";
export {
  createExternalMessageMappingSync,
  listExternalMessageMappingsSync,
  readExternalMessageMappingByDofeAgentMessageSync,
  readExternalMessageMappingByExternalMessageSync,
} from "./external-message-mappings.ts";
export {
  cancelExternalMessageOutboxForIntegrationSync,
  completeExternalMessageOutboxSync,
  createExternalMessageOutboxSync,
  failExternalMessageOutboxSync,
  listExternalMessageOutboxSync,
  listPendingExternalMessageOutboxSync,
  markExternalMessageOutboxLockedSync,
  readExternalMessageOutboxSync,
} from "./external-message-outbox.ts";
export {
  listExternalResourceBindingsSync,
  readExternalResourceBindingByKeySync,
  updateExternalResourceBindingStatusSync,
  upsertExternalResourceBindingSync,
} from "./external-resource-bindings.ts";
export {
  listExternalThreadBindingsSync,
  readExternalThreadBindingByIdSync,
  readExternalThreadBindingSync,
  upsertExternalThreadBindingSync,
} from "./external-thread-bindings.ts";
export {
  listExternalUserBindingsSync,
  readExternalUserBindingByExternalUserSync,
  readExternalUserBindingByIdSync,
  readExternalUserBindingSync,
  updateExternalUserBindingStatusSync,
  upsertExternalUserBindingSync,
} from "./external-user-bindings.ts";
