import {
  applyOpenMontageJobEvent,
  createOpenMontageJobProjection,
  parseOpenMontageJobEvent,
  type ApplyOpenMontageJobEventOutcome,
  type OpenMontageJobEvent,
  type OpenMontageJobProjection,
  type OpenMontageJobSnapshotSeed,
} from "@dofe-agent/domain";
import { getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { listUnresolvedOpenMontageDelegationIntentIdsSync } from "./openmontage-delegation-intents.ts";
import { voidOpenMontagePendingTokenUsageSync } from "./token-usage.ts";

export interface OpenMontageJobLinkRecord {
  jobId: string;
  workspaceId: string;
  employeeId: string;
  runtimeId: string;
  runtimeCredentialId: string;
  rootTaskId: string;
  conversationId: string;
  sourceInvocationId: string;
  traceId: string;
  workflowName: string;
  workflowVersion: string;
  createdAt: string;
}

export interface OpenMontageModelDelegationRecord {
  jobId: string;
  delegationId: string;
  runtimeCredentialId: string;
  modelsTenantId: string;
  modelsTeamId: string;
  mcpConnectionId: string;
  secretRef: string;
  spendLimit: string;
  currency: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenMontageChatBindingRecord {
  jobId: string;
  workspaceId: string;
  channelName: string;
  conversationMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenMontageNotificationOutboxRecord {
  id: string;
  jobId: string;
  workspaceId: string;
  channelName: string;
  eventSequence: number;
  eventType: "openmontage.job.changed";
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  deliveryAttempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface OpenMontagePurgeGuardSnapshot {
  inFlightJobIds: string[];
  unresolvedDelegationIds: string[];
  unreconciledUsageCount: number;
  purgeable: boolean;
}

export interface CreateOpenMontageJobLinkInput {
  workspaceId: string;
  employeeId: string;
  runtimeId: string;
  runtimeCredentialId: string;
  rootTaskId: string;
  conversationId: string;
  sourceInvocationId: string;
  traceId: string;
  snapshot: OpenMontageJobSnapshotSeed;
  delegation: Omit<OpenMontageModelDelegationRecord, "jobId" | "createdAt" | "updatedAt">;
  channelName?: string;
  conversationMessageId?: string;
  createdAt?: string;
}

export class OpenMontageJobBindingError extends Error {}
export class OpenMontageEventConflictError extends Error {}
export class OpenMontageEventNonceReplayError extends Error {}

export function createOpenMontageJobLinkSync(
  input: CreateOpenMontageJobLinkInput,
): OpenMontageJobLinkRecord {
  const projection = createOpenMontageJobProjection(input.snapshot);
  const db = getDatabase();
  const now = input.createdAt ?? new Date().toISOString();

  return withTransaction(db, () => {
    const existing = readOpenMontageJobLinkWithDatabase(db, input.snapshot.jobId);
    if (existing) {
      assertImmutableLink(existing, input);
      const existingDelegationRow = db.prepare(
        `${modelDelegationSelect()} WHERE job_id = ?`,
      ).get(input.snapshot.jobId) as Record<string, unknown> | undefined;
      if (!existingDelegationRow) {
        throw new OpenMontageJobBindingError("OpenMontage Job model delegation is missing.");
      }
      assertImmutableDelegation(mapModelDelegation(existingDelegationRow), input.delegation);
      if (input.channelName) {
        bindOpenMontageChatWithDatabase(db, {
          workspaceId: input.workspaceId,
          jobId: input.snapshot.jobId,
          channelName: input.channelName,
          conversationMessageId: input.conversationMessageId,
          now,
        });
      }
      return existing;
    }

    const invocationLink = db.prepare(
      `SELECT job_id AS "jobId"
       FROM openmontage_job_link
       WHERE workspace_id = ? AND source_invocation_id = ?`,
    ).get(input.workspaceId, input.sourceInvocationId) as { jobId?: string } | undefined;
    if (invocationLink?.jobId) {
      throw new OpenMontageJobBindingError(
        "OpenMontage source invocation already has immutable attribution to another Job.",
      );
    }

    db.prepare(
      `INSERT INTO openmontage_job_link (
        job_id, workspace_id, employee_id, runtime_id, runtime_credential_id, root_task_id,
        conversation_id, source_invocation_id, trace_id,
        workflow_name, workflow_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.snapshot.jobId,
      input.workspaceId,
      input.employeeId,
      input.runtimeId,
      input.runtimeCredentialId,
      input.rootTaskId,
      input.conversationId,
      input.sourceInvocationId,
      input.traceId,
      input.snapshot.workflow.name,
      input.snapshot.workflow.version,
      now,
    );
    insertOpenMontageModelDelegation(db, input.snapshot.jobId, input.delegation, now);
    db.prepare(
      `INSERT INTO openmontage_job_projection (
        job_id, workspace_id, status, current_stage, snapshot_json,
        last_applied_sequence, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projection.jobId,
      input.workspaceId,
      projection.status,
      projection.currentStage,
      JSON.stringify(projection),
      projection.lastAppliedSequence,
      projection.syncStatus,
      projection.createdAt,
      projection.updatedAt,
    );
    if (input.channelName) {
      bindOpenMontageChatWithDatabase(db, {
        workspaceId: input.workspaceId,
        jobId: input.snapshot.jobId,
        channelName: input.channelName,
        conversationMessageId: input.conversationMessageId,
        now,
      });
    }
    const created = readOpenMontageJobLinkWithDatabase(db, input.snapshot.jobId);
    if (!created) {
      throw new Error("OpenMontage Job Link could not be read after creation.");
    }
    return created;
  });
}

function assertImmutableDelegation(
  existing: OpenMontageModelDelegationRecord,
  expected: CreateOpenMontageJobLinkInput["delegation"],
): void {
  const existingValues = [
    existing.delegationId,
    existing.runtimeCredentialId,
    existing.modelsTenantId,
    existing.modelsTeamId,
    existing.mcpConnectionId,
    existing.secretRef,
    existing.spendLimit,
    existing.currency,
    existing.expiresAt,
  ];
  const expectedValues = [
    expected.delegationId,
    expected.runtimeCredentialId,
    expected.modelsTenantId,
    expected.modelsTeamId,
    expected.mcpConnectionId,
    expected.secretRef,
    expected.spendLimit,
    expected.currency,
    expected.expiresAt,
  ];
  if (stableJson(existingValues) !== stableJson(expectedValues)) {
    throw new OpenMontageJobBindingError("OpenMontage Job immutable delegation does not match.");
  }
}

export function readOpenMontageJobLinkSync(jobId: string): OpenMontageJobLinkRecord | null {
  return readOpenMontageJobLinkWithDatabase(getDatabase(), jobId);
}

export function readOpenMontageModelDelegationSync(jobId: string): OpenMontageModelDelegationRecord | null {
  const row = getDatabase().prepare(
    `${modelDelegationSelect()} WHERE job_id = ?`,
  ).get(jobId) as Record<string, unknown> | undefined;
  return row ? mapModelDelegation(row) : null;
}

export function updateOpenMontageModelDelegationStatusSync(jobId: string, status: string): void {
  const result = getDatabase().prepare(
    `UPDATE openmontage_model_delegation SET status = ?, updated_at = ? WHERE job_id = ?`,
  ).run(status, new Date().toISOString(), jobId);
  if (result.changes === 0) {
    throw new OpenMontageJobBindingError("OpenMontage model delegation is missing.");
  }
}

export function listOpenMontageDelegationDrainPendingJobIdsSync(
  options: { limit?: number } = {},
): string[] {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  const rows = getDatabase().prepare(
    `SELECT job_id AS "jobId"
       FROM openmontage_model_delegation
      WHERE status = 'drain_pending'
      ORDER BY updated_at ASC, job_id ASC
      LIMIT ?`,
  ).all(limit) as Array<{ jobId?: unknown }>;
  return rows.flatMap((row) => typeof row.jobId === "string" ? [row.jobId] : []);
}

export function listOpenMontageModelDelegationsForRuntimeSync(
  workspaceId: string,
  runtimeId: string,
): OpenMontageModelDelegationRecord[] {
  const rows = getDatabase().prepare(
    `${modelDelegationSelect("delegation")}
       JOIN openmontage_job_link link ON link.job_id = delegation.job_id
      WHERE link.workspace_id = ? AND link.runtime_id = ?`,
  ).all(workspaceId, runtimeId) as Array<Record<string, unknown>>;
  return rows.map(mapModelDelegation);
}

export function listOpenMontageModelDelegationsForMcpConnectionSync(
  workspaceId: string,
  connectionId: string,
): OpenMontageModelDelegationRecord[] {
  const rows = getDatabase().prepare(
    `${modelDelegationSelect("delegation")}
       JOIN openmontage_job_link link ON link.job_id = delegation.job_id
      WHERE link.workspace_id = ? AND delegation.mcp_connection_id = ?`,
  ).all(workspaceId, connectionId) as Array<Record<string, unknown>>;
  return rows.map(mapModelDelegation);
}

export function readOpenMontageRuntimePurgeGuardSync(
  workspaceId: string,
  runtimeId: string,
): OpenMontagePurgeGuardSnapshot {
  return readOpenMontagePurgeGuardSync("runtime", "link.runtime_id = ?", workspaceId, runtimeId);
}

export function readOpenMontageMcpPurgeGuardSync(
  workspaceId: string,
  connectionId: string,
): OpenMontagePurgeGuardSnapshot {
  return readOpenMontagePurgeGuardSync(
    "mcp_connection",
    "delegation.mcp_connection_id = ?",
    workspaceId,
    connectionId,
  );
}

function readOpenMontagePurgeGuardSync(
  targetType: "runtime" | "mcp_connection",
  targetPredicate: string,
  workspaceId: string,
  targetId: string,
): OpenMontagePurgeGuardSnapshot {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT link.job_id AS "jobId",
            projection.status AS "jobStatus",
            delegation.delegation_id AS "delegationId",
            delegation.status AS "delegationStatus",
            delegation.runtime_credential_id AS "runtimeCredentialId"
       FROM openmontage_job_link link
       JOIN openmontage_model_delegation delegation ON delegation.job_id = link.job_id
       LEFT JOIN openmontage_job_projection projection ON projection.job_id = link.job_id
      WHERE link.workspace_id = ? AND ${targetPredicate}`,
  ).all(workspaceId, targetId) as Array<Record<string, unknown>>;
  const inFlightJobIds = rows.flatMap((row) =>
    !["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(row.jobStatus))
      ? [String(row.jobId)]
      : [],
  );
  const unresolvedDelegationIds = rows.flatMap((row) =>
    !["revoked", "expired", "exhausted"].includes(String(row.delegationStatus))
      ? [String(row.delegationId)]
      : [],
  );
  unresolvedDelegationIds.push(...listUnresolvedOpenMontageDelegationIntentIdsSync({
    workspaceId,
    targetType,
    targetId,
  }));
  const credentialIds = [...new Set(rows.map((row) => String(row.runtimeCredentialId)))];
  let unreconciledUsageCount = 0;
  if (credentialIds.length > 0) {
    const placeholders = credentialIds.map(() => "?").join(", ");
    const count = db.prepare(
      `SELECT COUNT(*) AS count
         FROM token_usage
        WHERE workspace_id = ?
          AND runtime_credential_id IN (${placeholders})
          AND billing_status IN ('pending_reconciliation', 'unallocated')`,
    ).get(workspaceId, ...credentialIds) as { count?: unknown } | undefined;
    unreconciledUsageCount = Number(count?.count ?? 0);
  }
  return {
    inFlightJobIds,
    unresolvedDelegationIds,
    unreconciledUsageCount,
    purgeable:
      inFlightJobIds.length === 0
      && unresolvedDelegationIds.length === 0
      && unreconciledUsageCount === 0,
  };
}

export function readOpenMontageJobProjectionSync(
  workspaceId: string,
  jobId: string,
): OpenMontageJobProjection | null {
  return readProjectionWithDatabase(getDatabase(), workspaceId, jobId);
}

export function readOpenMontageChatBindingSync(
  workspaceId: string,
  jobId: string,
): OpenMontageChatBindingRecord | null {
  const row = getDatabase().prepare(
    `${chatBindingSelect()} WHERE workspace_id = ? AND job_id = ?`,
  ).get(workspaceId, jobId) as Record<string, unknown> | undefined;
  return row ? mapChatBinding(row) : null;
}

export function listOpenMontageChannelProjectionVersionsSync(
  workspaceId: string,
  channelName: string,
): Array<{ jobId: string; lastAppliedSequence: number; changedAt: string }> {
  const rows = getDatabase().prepare(
    `SELECT projection.job_id AS "jobId",
            projection.last_applied_sequence AS "lastAppliedSequence",
            projection.updated_at AS "changedAt"
       FROM openmontage_job_projection projection
       JOIN openmontage_chat_binding binding ON binding.job_id = projection.job_id
      WHERE projection.workspace_id = ?
        AND binding.workspace_id = ?
        AND binding.channel_name = ?
      ORDER BY projection.job_id ASC`,
  ).all(workspaceId, workspaceId, channelName) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    jobId: String(row.jobId),
    lastAppliedSequence: Number(row.lastAppliedSequence),
    changedAt: String(row.changedAt),
  }));
}

export function listOpenMontageChannelProjectionsSync(
  workspaceId: string,
  channelName: string,
): OpenMontageJobProjection[] {
  const rows = getDatabase().prepare(
    `SELECT projection.snapshot_json AS "snapshotJson"
       FROM openmontage_job_projection projection
       JOIN openmontage_chat_binding binding ON binding.job_id = projection.job_id
      WHERE projection.workspace_id = ?
        AND binding.workspace_id = ?
        AND binding.channel_name = ?
      ORDER BY projection.created_at ASC, projection.job_id ASC`,
  ).all(workspaceId, workspaceId, channelName) as Array<{ snapshotJson?: unknown }>;
  return rows.map((row) => parseJson(row.snapshotJson) as OpenMontageJobProjection);
}

export function listOpenMontageSyncingJobIdsSync(options: { limit?: number } = {}): string[] {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  const rows = getDatabase().prepare(
    `SELECT job_id AS "jobId"
     FROM openmontage_job_projection
     WHERE sync_status = 'SYNCING'
     ORDER BY updated_at ASC, job_id ASC
     LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.jobId));
}

export function ingestOpenMontageJobEventSync(
  event: OpenMontageJobEvent,
  input: { nonce: string; receivedAt?: string; nonceExpiresAt?: string },
): {
  outcome: ApplyOpenMontageJobEventOutcome;
  projection: OpenMontageJobProjection;
  notification?: OpenMontageNotificationOutboxRecord;
} {
  const db = getDatabase();
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const nonceExpiresAt = input.nonceExpiresAt
    ?? new Date(Date.parse(receivedAt) + 10 * 60_000).toISOString();

  return withTransaction(db, () => {
    db.prepare("DELETE FROM openmontage_event_nonce WHERE expires_at < ?").run(receivedAt);
    try {
      db.prepare(
        `INSERT INTO openmontage_event_nonce (nonce, event_id, received_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).run(input.nonce, event.eventId, receivedAt, nonceExpiresAt);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new OpenMontageEventNonceReplayError("OpenMontage event nonce was already used.");
      }
      throw error;
    }

    const link = readOpenMontageJobLinkWithDatabase(db, event.jobId);
    if (!link) {
      throw new OpenMontageJobBindingError("OpenMontage Job has no trusted AgentSpace binding.");
    }
    assertEventAttribution(link, event);

    const existingEvent = db.prepare(
      `SELECT event_json AS "eventJson"
       FROM openmontage_job_event
       WHERE event_id = ? OR (job_id = ? AND sequence = ?)
       LIMIT 1`,
    ).get(event.eventId, event.jobId, event.sequence) as { eventJson?: unknown } | undefined;
    if (existingEvent) {
      const persisted = parseOpenMontageJobEvent(parseJson(existingEvent.eventJson));
      if (stableJson(persisted) !== stableJson(event)) {
        throw new OpenMontageEventConflictError(
          "OpenMontage event identity or sequence conflicts with persisted content.",
        );
      }
      const projection = requireProjection(db, event.workspaceId, event.jobId);
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(projection.status)) {
        voidOpenMontagePendingTokenUsageSync({ workspaceId: event.workspaceId, jobId: event.jobId });
      }
      return { outcome: "duplicate", projection };
    }

    db.prepare(
      `INSERT INTO openmontage_job_event (
        event_id, job_id, workspace_id, sequence, schema_version,
        event_type, event_json, application_status, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      event.eventId,
      event.jobId,
      event.workspaceId,
      event.sequence,
      event.schemaVersion,
      event.eventType,
      JSON.stringify(event),
      receivedAt,
    );

    let projection = requireProjection(db, event.workspaceId, event.jobId);
    const firstResult = applyOpenMontageJobEvent(projection, event);
    let outcome = firstResult.outcome;
    projection = firstResult.projection;

    if (outcome === "duplicate") {
      markEventApplication(db, event.eventId, "applied", receivedAt);
      return { outcome, projection };
    }
    if (outcome === "gap") {
      saveProjection(db, event.workspaceId, projection);
      const notification = queueProjectionNotification(db, projection, link, event.sequence, receivedAt);
      return { outcome, projection, notification };
    }

    markEventApplication(db, event.eventId, outcome === "ignored_terminal" ? outcome : "applied", receivedAt);
    while (true) {
      const next = db.prepare(
        `SELECT event_id AS "eventId", event_json AS "eventJson"
         FROM openmontage_job_event
         WHERE job_id = ? AND sequence = ? AND application_status = 'pending'`,
      ).get(event.jobId, projection.lastAppliedSequence + 1) as
        | { eventId?: string; eventJson?: unknown }
        | undefined;
      if (!next?.eventId) {
        break;
      }
      const buffered = parseOpenMontageJobEvent(parseJson(next.eventJson));
      const bufferedResult = applyOpenMontageJobEvent(projection, buffered);
      if (bufferedResult.outcome === "gap" || bufferedResult.outcome === "duplicate") {
        break;
      }
      projection = bufferedResult.projection;
      markEventApplication(
        db,
        next.eventId,
        bufferedResult.outcome === "ignored_terminal" ? "ignored_terminal" : "applied",
        receivedAt,
      );
    }

    saveProjection(db, event.workspaceId, projection);
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(projection.status)) {
      voidOpenMontagePendingTokenUsageSync({ workspaceId: event.workspaceId, jobId: event.jobId });
    }
    const notification = queueProjectionNotification(
      db,
      projection,
      link,
      projection.lastAppliedSequence,
      receivedAt,
    );
    return { outcome, projection, notification };
  });
}

export function listOpenMontageNotificationOutboxSync(options: {
  status?: OpenMontageNotificationOutboxRecord["status"];
  limit?: number;
} = {}): OpenMontageNotificationOutboxRecord[] {
  const where = options.status ? "WHERE status = ?" : "";
  const params: unknown[] = options.status ? [options.status] : [];
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  const rows = getDatabase().prepare(
    `${notificationSelect()} ${where} ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(mapNotification);
}

export function markOpenMontageNotificationDeliveredSync(id: string): void {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE openmontage_notification_outbox
     SET status = 'delivered', delivered_at = ?, next_attempt_at = NULL, last_error = NULL
     WHERE id = ?`,
  ).run(now, id);
}

function readOpenMontageJobLinkWithDatabase(
  db: ReturnType<typeof getDatabase>,
  jobId: string,
): OpenMontageJobLinkRecord | null {
  const row = db.prepare(
    `${jobLinkSelect()} WHERE job_id = ?`,
  ).get(jobId) as Record<string, unknown> | undefined;
  return row ? mapJobLink(row) : null;
}

function readProjectionWithDatabase(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
  jobId: string,
): OpenMontageJobProjection | null {
  const row = db.prepare(
    `SELECT snapshot_json AS "snapshotJson"
     FROM openmontage_job_projection
     WHERE workspace_id = ? AND job_id = ?`,
  ).get(workspaceId, jobId) as { snapshotJson?: unknown } | undefined;
  if (!row) {
    return null;
  }
  return parseJson(row.snapshotJson) as OpenMontageJobProjection;
}

function requireProjection(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
  jobId: string,
): OpenMontageJobProjection {
  const projection = readProjectionWithDatabase(db, workspaceId, jobId);
  if (!projection) {
    throw new OpenMontageJobBindingError("OpenMontage Job projection is missing.");
  }
  return projection;
}

function saveProjection(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
  projection: OpenMontageJobProjection,
): void {
  db.prepare(
    `UPDATE openmontage_job_projection
     SET status = ?, current_stage = ?, snapshot_json = ?,
         last_applied_sequence = ?, sync_status = ?, updated_at = ?
     WHERE workspace_id = ? AND job_id = ?`,
  ).run(
    projection.status,
    projection.currentStage,
    JSON.stringify(projection),
    projection.lastAppliedSequence,
    projection.syncStatus,
    projection.updatedAt,
    workspaceId,
    projection.jobId,
  );
}

function markEventApplication(
  db: ReturnType<typeof getDatabase>,
  eventId: string,
  status: "applied" | "ignored_terminal",
  appliedAt: string,
): void {
  db.prepare(
    `UPDATE openmontage_job_event
     SET application_status = ?, applied_at = ?, failure_reason = NULL
     WHERE event_id = ?`,
  ).run(status, appliedAt, eventId);
}

function queueProjectionNotification(
  db: ReturnType<typeof getDatabase>,
  projection: OpenMontageJobProjection,
  link: OpenMontageJobLinkRecord,
  eventSequence: number,
  createdAt: string,
): OpenMontageNotificationOutboxRecord | undefined {
  const binding = db.prepare(
    `${chatBindingSelect()} WHERE workspace_id = ? AND job_id = ?`,
  ).get(link.workspaceId, link.jobId) as Record<string, unknown> | undefined;
  if (!binding) {
    return undefined;
  }
  const mappedBinding = mapChatBinding(binding);
  const payload = {
    workspaceId: link.workspaceId,
    channelName: mappedBinding.channelName,
    jobId: link.jobId,
    lastAppliedSequence: projection.lastAppliedSequence,
    changedAt: projection.updatedAt,
  };
  db.prepare(
    `INSERT INTO openmontage_notification_outbox (
      id, job_id, workspace_id, channel_name, event_sequence,
      event_type, payload_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'openmontage.job.changed', ?, 'pending', ?)
    ON CONFLICT(job_id, event_sequence, event_type) DO UPDATE SET
      payload_json = EXCLUDED.payload_json,
      status = 'pending',
      next_attempt_at = NULL,
      last_error = NULL,
      delivered_at = NULL`,
  ).run(
    `om-notify-${randomLikeId()}`,
    link.jobId,
    link.workspaceId,
    mappedBinding.channelName,
    eventSequence,
    JSON.stringify(payload),
    createdAt,
  );
  const row = db.prepare(
    `${notificationSelect()}
     WHERE job_id = ? AND event_sequence = ? AND event_type = 'openmontage.job.changed'`,
  ).get(link.jobId, eventSequence) as Record<string, unknown> | undefined;
  return row ? mapNotification(row) : undefined;
}

function bindOpenMontageChatWithDatabase(
  db: ReturnType<typeof getDatabase>,
  input: {
    workspaceId: string;
    jobId: string;
    channelName: string;
    conversationMessageId?: string;
    now: string;
  },
): void {
  const existing = db.prepare(
    `${chatBindingSelect()} WHERE job_id = ?`,
  ).get(input.jobId) as Record<string, unknown> | undefined;
  if (existing) {
    const binding = mapChatBinding(existing);
    if (binding.workspaceId !== input.workspaceId || binding.channelName !== input.channelName) {
      throw new OpenMontageJobBindingError("OpenMontage chat binding is immutable.");
    }
    if (
      binding.conversationMessageId
      && input.conversationMessageId
      && binding.conversationMessageId !== input.conversationMessageId
    ) {
      throw new OpenMontageJobBindingError("OpenMontage chat binding message is immutable.");
    }
    if (!binding.conversationMessageId && input.conversationMessageId) {
      db.prepare(
        `UPDATE openmontage_chat_binding
         SET conversation_message_id = ?, updated_at = ?
         WHERE job_id = ? AND workspace_id = ?`,
      ).run(input.conversationMessageId, input.now, input.jobId, input.workspaceId);
    }
    return;
  }
  db.prepare(
    `INSERT INTO openmontage_chat_binding (
      job_id, workspace_id, channel_name, conversation_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.workspaceId,
    input.channelName,
    input.conversationMessageId ?? null,
    input.now,
    input.now,
  );
}

function assertImmutableLink(
  existing: OpenMontageJobLinkRecord,
  input: CreateOpenMontageJobLinkInput,
): void {
  const expected = [
    input.workspaceId,
    input.employeeId,
    input.runtimeId,
    input.runtimeCredentialId,
    input.rootTaskId,
    input.conversationId,
    input.sourceInvocationId,
    input.traceId,
    input.snapshot.workflow.name,
    input.snapshot.workflow.version,
  ];
  const actual = [
    existing.workspaceId,
    existing.employeeId,
    existing.runtimeId,
    existing.runtimeCredentialId,
    existing.rootTaskId,
    existing.conversationId,
    existing.sourceInvocationId,
    existing.traceId,
    existing.workflowName,
    existing.workflowVersion,
  ];
  if (stableJson(actual) !== stableJson(expected)) {
    throw new OpenMontageJobBindingError("OpenMontage Job immutable attribution does not match.");
  }
}

function assertEventAttribution(
  link: OpenMontageJobLinkRecord,
  event: OpenMontageJobEvent,
): void {
  const matches =
    link.workspaceId === event.workspaceId
    && link.employeeId === event.employeeId
    && link.runtimeId === event.runtimeId
    && link.rootTaskId === event.rootTaskId
    && link.conversationId === event.conversationId
    && link.sourceInvocationId === event.sourceInvocationId
    && link.traceId === event.traceId;
  if (!matches) {
    throw new OpenMontageJobBindingError("OpenMontage event attribution does not match its Job Link.");
  }
}

function jobLinkSelect(): string {
  return `SELECT
    job_id AS "jobId", workspace_id AS "workspaceId", employee_id AS "employeeId",
    runtime_id AS "runtimeId", root_task_id AS "rootTaskId",
    runtime_credential_id AS "runtimeCredentialId",
    conversation_id AS "conversationId", source_invocation_id AS "sourceInvocationId",
    trace_id AS "traceId", workflow_name AS "workflowName",
    workflow_version AS "workflowVersion", created_at AS "createdAt"
    FROM openmontage_job_link`;
}

function modelDelegationSelect(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  const from = alias ? `openmontage_model_delegation ${alias}` : "openmontage_model_delegation";
  return `SELECT ${prefix}job_id AS "jobId", ${prefix}delegation_id AS "delegationId",
    ${prefix}runtime_credential_id AS "runtimeCredentialId", ${prefix}models_tenant_id AS "modelsTenantId",
    ${prefix}models_team_id AS "modelsTeamId", ${prefix}mcp_connection_id AS "mcpConnectionId",
    ${prefix}secret_ref AS "secretRef", ${prefix}spend_limit AS "spendLimit", ${prefix}currency, ${prefix}status,
    ${prefix}expires_at AS "expiresAt", ${prefix}created_at AS "createdAt", ${prefix}updated_at AS "updatedAt"
    FROM ${from}`;
}

function chatBindingSelect(): string {
  return `SELECT
    job_id AS "jobId", workspace_id AS "workspaceId", channel_name AS "channelName",
    conversation_message_id AS "conversationMessageId", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM openmontage_chat_binding`;
}

function notificationSelect(): string {
  return `SELECT
    id, job_id AS "jobId", workspace_id AS "workspaceId", channel_name AS "channelName",
    event_sequence AS "eventSequence", event_type AS "eventType", payload_json AS "payloadJson",
    status, delivery_attempts AS "deliveryAttempts", next_attempt_at AS "nextAttemptAt",
    last_error AS "lastError", created_at AS "createdAt", delivered_at AS "deliveredAt"
    FROM openmontage_notification_outbox`;
}

function mapJobLink(row: Record<string, unknown>): OpenMontageJobLinkRecord {
  return {
    jobId: String(row.jobId),
    workspaceId: String(row.workspaceId),
    employeeId: String(row.employeeId),
    runtimeId: String(row.runtimeId),
    runtimeCredentialId: String(row.runtimeCredentialId),
    rootTaskId: String(row.rootTaskId),
    conversationId: String(row.conversationId),
    sourceInvocationId: String(row.sourceInvocationId),
    traceId: String(row.traceId),
    workflowName: String(row.workflowName),
    workflowVersion: String(row.workflowVersion),
    createdAt: String(row.createdAt),
  };
}

function mapModelDelegation(row: Record<string, unknown>): OpenMontageModelDelegationRecord {
  return {
    jobId: String(row.jobId),
    delegationId: String(row.delegationId),
    runtimeCredentialId: String(row.runtimeCredentialId),
    modelsTenantId: String(row.modelsTenantId),
    modelsTeamId: String(row.modelsTeamId),
    mcpConnectionId: String(row.mcpConnectionId),
    secretRef: String(row.secretRef),
    spendLimit: String(row.spendLimit),
    currency: String(row.currency),
    status: String(row.status),
    expiresAt: String(row.expiresAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function insertOpenMontageModelDelegation(
  db: ReturnType<typeof getDatabase>,
  jobId: string,
  delegation: CreateOpenMontageJobLinkInput["delegation"],
  now: string,
): void {
  db.prepare(
    `INSERT INTO openmontage_model_delegation (
      job_id, delegation_id, runtime_credential_id, models_tenant_id, models_team_id,
      mcp_connection_id, secret_ref, spend_limit, currency, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    delegation.delegationId,
    delegation.runtimeCredentialId,
    delegation.modelsTenantId,
    delegation.modelsTeamId,
    delegation.mcpConnectionId,
    delegation.secretRef,
    delegation.spendLimit,
    delegation.currency,
    delegation.status,
    delegation.expiresAt,
    now,
    now,
  );
}

function mapChatBinding(row: Record<string, unknown>): OpenMontageChatBindingRecord {
  return {
    jobId: String(row.jobId),
    workspaceId: String(row.workspaceId),
    channelName: String(row.channelName),
    conversationMessageId: typeof row.conversationMessageId === "string" ? row.conversationMessageId : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function mapNotification(row: Record<string, unknown>): OpenMontageNotificationOutboxRecord {
  return {
    id: String(row.id),
    jobId: String(row.jobId),
    workspaceId: String(row.workspaceId),
    channelName: String(row.channelName),
    eventSequence: Number(row.eventSequence),
    eventType: "openmontage.job.changed",
    payload: parseJson(row.payloadJson) as Record<string, unknown>,
    status: row.status as OpenMontageNotificationOutboxRecord["status"],
    deliveryAttempts: Number(row.deliveryAttempts),
    nextAttemptAt: typeof row.nextAttemptAt === "string" ? row.nextAttemptAt : undefined,
    lastError: typeof row.lastError === "string" ? row.lastError : undefined,
    createdAt: String(row.createdAt),
    deliveredAt: typeof row.deliveredAt === "string" ? row.deliveredAt : undefined,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /duplicate key|unique constraint/i.test(error.message);
}
