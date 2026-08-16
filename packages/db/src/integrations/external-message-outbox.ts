import { createHash } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "../database.ts";
import {
  type JsonInput,
  DEFAULT_JSON_OBJECT,
  updateExternalMessageOutboxTerminalStatus,
  requireExternalMessageOutbox,
  selectExternalMessageOutboxSql,
  mapExternalMessageOutboxRecord,
  normalizeRequiredText,
  normalizeOptionalText,
  normalizeJsonInput,
  buildExternalMessageOutboxMetadataJson,
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

export function createExternalMessageOutboxSync(input: {
  workspaceId?: string;
  integrationId: string;
  channelBindingId?: string;
  targetExternalChatId: string;
  targetExternalThreadId?: string;
  dofeAgentMessageId?: string;
  payloadJson: JsonInput;
  metadataJson?: JsonInput;
  nextAttemptAt?: string;
  idempotencyKey?: string;
}): ExternalMessageOutboxRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External message outbox integration id is required.");
  const targetExternalChatId = normalizeRequiredText(input.targetExternalChatId, "External message outbox target chat id is required.");
  const metadataJson = buildExternalMessageOutboxMetadataJson({
    workspaceId,
    integrationId,
    metadataJson: input.metadataJson,
  });
  const idempotencyKey = input.idempotencyKey?.trim();
  const id = idempotencyKey
    ? `external-message-outbox-${createHash("sha256")
      .update(`${workspaceId}\0${integrationId}\0${idempotencyKey}`)
      .digest("hex")
      .slice(0, 48)}`
    : `external-message-outbox-${randomLikeId()}`;
  const now = new Date().toISOString();

  getDatabase().prepare(
    `INSERT INTO external_message_outbox (
       id,
       workspace_id,
       integration_id,
       channel_binding_id,
       target_external_chat_id,
       target_external_thread_id,
       dofe_agent_message_id,
       payload_json,
       metadata_json,
       status,
       attempts,
       next_attempt_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    id,
    workspaceId,
    integrationId,
    normalizeOptionalText(input.channelBindingId),
    targetExternalChatId,
    normalizeOptionalText(input.targetExternalThreadId),
    normalizeOptionalText(input.dofeAgentMessageId),
    normalizeJsonInput(input.payloadJson, DEFAULT_JSON_OBJECT),
    metadataJson,
    normalizeOptionalText(input.nextAttemptAt),
    now,
    now,
  );

  return requireExternalMessageOutbox({ workspaceId, outboxId: id });
}

export function readExternalMessageOutboxSync(input: {
  workspaceId?: string;
  outboxId: string;
}): ExternalMessageOutboxRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${selectExternalMessageOutboxSql()}
     WHERE workspace_id = ? AND id = ?`,
  ).get(workspaceId, input.outboxId.trim()) as Record<string, unknown> | undefined;

  return row ? mapExternalMessageOutboxRecord(row) : null;
}

export function listPendingExternalMessageOutboxSync(options: {
  workspaceId?: string;
  integrationId?: string;
  now?: string;
  limit?: number;
} = {}): ExternalMessageOutboxRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const dueAt = options.now ?? new Date().toISOString();
  const where = [
    "workspace_id = ?",
    "status = 'pending'",
    "(next_attempt_at IS NULL OR next_attempt_at <= ?)",
  ];
  const params: unknown[] = [workspaceId, dueAt];
  if (options.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(options.integrationId.trim());
  }
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = getDatabase().prepare(
    `${selectExternalMessageOutboxSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, id ASC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalMessageOutboxRecord).filter((record): record is ExternalMessageOutboxRecord => record !== null);
}

export function listExternalMessageOutboxSync(options: {
  workspaceId?: string;
  integrationId?: string;
  status?: ExternalMessageOutboxStatus;
  limit?: number;
} = {}): ExternalMessageOutboxRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.integrationId?.trim()) {
    where.push("integration_id = ?");
    params.push(options.integrationId.trim());
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = getDatabase().prepare(
    `${selectExternalMessageOutboxSql()}
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;

  return rows.map(mapExternalMessageOutboxRecord).filter((record): record is ExternalMessageOutboxRecord => record !== null);
}

export function markExternalMessageOutboxLockedSync(input: {
  workspaceId?: string;
  outboxId: string;
  lockedBy: string;
}): ExternalMessageOutboxRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE external_message_outbox
     SET status = 'locked',
         attempts = attempts + 1,
         locked_at = ?,
         locked_by = ?,
         updated_at = ?
     WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
  ).run(now, normalizeRequiredText(input.lockedBy, "External message outbox lock owner is required."), now, workspaceId, input.outboxId.trim());

  if (result.changes === 0) {
    throw new Error("External message outbox item is not pending or does not exist.");
  }
  return requireExternalMessageOutbox({ workspaceId, outboxId: input.outboxId });
}

export function completeExternalMessageOutboxSync(input: {
  workspaceId?: string;
  outboxId: string;
}): ExternalMessageOutboxRecord {
  return updateExternalMessageOutboxTerminalStatus({
    workspaceId: input.workspaceId,
    outboxId: input.outboxId,
    status: "sent",
    sentAt: new Date().toISOString(),
  });
}

export function failExternalMessageOutboxSync(input: {
  workspaceId?: string;
  outboxId: string;
  lastError: string;
  nextAttemptAt?: string;
  terminal?: boolean;
}): ExternalMessageOutboxRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const status: ExternalMessageOutboxStatus = input.terminal ? "failed" : "pending";
  const result = getDatabase().prepare(
    `UPDATE external_message_outbox
     SET status = ?,
         locked_at = NULL,
         locked_by = NULL,
         last_error = ?,
         next_attempt_at = ?,
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(
    status,
    normalizeRequiredText(input.lastError, "External message outbox failure reason is required."),
    normalizeOptionalText(input.nextAttemptAt),
    now,
    workspaceId,
    input.outboxId.trim(),
  );

  if (result.changes === 0) {
    throw new Error("External message outbox item does not exist.");
  }
  return requireExternalMessageOutbox({ workspaceId, outboxId: input.outboxId });
}

export function cancelExternalMessageOutboxForIntegrationSync(input: {
  workspaceId?: string;
  integrationId: string;
  reason?: string;
}): number {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const integrationId = normalizeRequiredText(input.integrationId, "External message outbox integration id is required.");
  const now = new Date().toISOString();
  const reason = normalizeOptionalText(input.reason);
  const result = getDatabase().prepare(
    `UPDATE external_message_outbox
     SET status = 'cancelled',
         locked_at = NULL,
         locked_by = NULL,
         last_error = COALESCE(?, last_error),
         next_attempt_at = NULL,
         updated_at = ?
     WHERE workspace_id = ?
       AND integration_id = ?
       AND status IN ('pending', 'locked')`,
  ).run(reason, now, workspaceId, integrationId);

  return result.changes;
}


export type { ExternalMessageOutboxRecord, ExternalMessageOutboxStatus } from "../types.ts";
