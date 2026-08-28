import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  requireExternalDataOperationRun,
  selectExternalDataOperationRunSql,
  mapExternalDataOperationRunRecord,
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

export function createExternalDataOperationRunSync(input: {
  workspaceId?: string;
  integrationId: string;
  resourceBindingId?: string;
  operationType: string;
  providerResourceType: ExternalResourceBindingProviderType;
  providerResourceToken: string;
  actorType: ExternalDataOperationActorType;
  actorId?: string;
  status?: ExternalDataOperationRunStatus;
  requestJson?: JsonInput;
}): ExternalDataOperationRunRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const id = `external-data-operation-${randomLikeId()}`;
  const now = new Date().toISOString();
  const status = input.status ?? "pending";
  const startedAt = status === "running" ? now : null;

  getDatabase().prepare(
    `INSERT INTO external_data_operation_run (
       id,
       workspace_id,
       integration_id,
       resource_binding_id,
       operation_type,
       provider_resource_type,
       provider_resource_token,
       actor_type,
       actor_id,
       status,
       request_json,
       result_json,
       started_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    normalizeRequiredText(input.integrationId, "External data operation integration id is required."),
    normalizeOptionalText(input.resourceBindingId),
    normalizeRequiredText(input.operationType, "External data operation type is required."),
    normalizeRequiredText(input.providerResourceType, "External data operation provider resource type is required."),
    normalizeRequiredText(input.providerResourceToken, "External data operation provider resource token is required."),
    input.actorType,
    normalizeOptionalText(input.actorId),
    status,
    normalizeJsonInput(input.requestJson, DEFAULT_JSON_OBJECT),
    startedAt,
    now,
    now,
  );

  return requireExternalDataOperationRun({ workspaceId, runId: id });
}

export function updateExternalDataOperationRunStatusSync(input: {
  workspaceId?: string;
  runId: string;
  status: ExternalDataOperationRunStatus;
  resultJson?: JsonInput;
  errorCode?: string;
  errorMessage?: string;
}): ExternalDataOperationRunRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const finishedAt = input.status === "succeeded" || input.status === "failed" || input.status === "cancelled" ? now : null;
  const result = getDatabase().prepare(
    `UPDATE external_data_operation_run
     SET status = ?,
         result_json = ?,
         error_code = ?,
         error_message = ?,
         started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
         finished_at = COALESCE(?, finished_at),
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(
    input.status,
    normalizeJsonInput(input.resultJson, DEFAULT_JSON_OBJECT),
    normalizeOptionalText(input.errorCode),
    normalizeOptionalText(input.errorMessage),
    input.status,
    now,
    finishedAt,
    now,
    workspaceId,
    input.runId.trim(),
  );

  if (result.changes === 0) {
    throw new Error("External data operation run does not exist.");
  }
  return requireExternalDataOperationRun({ workspaceId, runId: input.runId });
}

export function readExternalDataOperationRunSync(input: {
  workspaceId?: string;
  runId: string;
}): ExternalDataOperationRunRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalDataOperationRunSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, input.runId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalDataOperationRunRecord(row) : null;
}

export function listExternalDataOperationRunsSync(options: {
  workspaceId?: string;
  integrationId?: string;
  resourceBindingId?: string;
  status?: ExternalDataOperationRunStatus;
  limit?: number;
} = {}): ExternalDataOperationRunRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(options.integrationId.trim());
  }
  if (options.resourceBindingId?.trim()) {
    where.push("resource_binding_id = ?");
    params.push(options.resourceBindingId.trim());
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));

  const rows = getDatabase().prepare(
    `${selectExternalDataOperationRunSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalDataOperationRunRecord).filter((record): record is ExternalDataOperationRunRecord => record !== null);
}


export type {
  ExternalDataOperationActorType,
  ExternalDataOperationRunRecord,
  ExternalDataOperationRunStatus,
} from "../types.ts";
