// 多会话拆分领域访问层（docs/0820/session-split）。
// Conversation / Participant / Execution Lane / Provider Session 四个对象与
// agent_task_queue 的会话身份列共同构成「一会话一队列」的服务端真相。
// 所有写操作为同步、幂等；Execution Lane 以 (workspace_id, conversation_id, employee_id) 为唯一键。

import { createHash } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { upsertAgentRouterSessionSync } from "./agent-router-sessions.ts";

export type ConversationStatus = "draft" | "active" | "idle" | "failed" | "archived" | "abandoned";
export type ConversationKind = "direct" | "group";
export type ConversationSummarySource = "fallback" | "generated" | "user";
export type ConversationParticipantType = "human" | "employee";
export type ExecutionLaneStatus = "idle" | "queued" | "running" | "capacity_wait" | "failed" | "stopped";
export type ConversationProviderSessionStatus = "active" | "invalid" | "superseded" | "closed";

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  channelId?: string;
  createdByUserId?: string;
  status: ConversationStatus;
  title?: string;
  summary?: string;
  summarySource: ConversationSummarySource;
  lastMessageAt?: string;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  version: number;
}

export interface ConversationParticipantRecord {
  id: string;
  conversationId: string;
  participantType: ConversationParticipantType;
  userId?: string;
  employeeId?: string;
  displayNameSnapshot?: string;
  joinedAt: string;
  leftAt?: string;
}

export interface ConversationExecutionLaneRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  employeeId: string;
  routerSessionId?: string;
  activeProviderSessionId?: string;
  workDir?: string;
  status: ExecutionLaneStatus;
  activeTaskQueueId?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationProviderSessionRecord {
  id: string;
  executionLaneId: string;
  provider: string;
  runtimeId?: string;
  providerSessionId: string;
  status: ConversationProviderSessionStatus;
  startedAt?: string;
  lastUsedAt?: string;
  invalidatedAt?: string;
  invalidReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  workspaceId?: string;
  idempotencyKey?: string;
  /** 显式指定会话 ID（legacy 回填用确定性 ID）。 */
  id?: string;
  kind?: ConversationKind;
  channelId?: string;
  createdByUserId?: string;
  /** 直接会话：单个员工。 */
  employeeId?: string;
  employeeName?: string;
  /** 群聊会话：一个或多个员工参与者（kind=group）。 */
  employeeParticipants?: Array<{ employeeId: string; employeeName?: string }>;
  title?: string;
  summary?: string;
  now?: string;
}

export interface CreateConversationResult {
  conversation: ConversationRecord;
  /** 直接会话在创建时即建立 Lane；群聊 Lane 按 employee 惰性建立，故可缺省。 */
  lane?: ConversationExecutionLaneRecord;
}

export function createConversationSync(input: CreateConversationInput): CreateConversationResult {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();
  const kind: ConversationKind = input.kind ?? "direct";
  const idempotencyKey = input.idempotencyKey?.trim();
  const id = input.id
    ?? (idempotencyKey
      ? `conversation-idem-${createHash("sha256").update(`${workspaceId}\0${idempotencyKey}`).digest("hex").slice(0, 32)}`
      : `conversation-${randomLikeId()}`);
  const employeeParticipants = kind === "direct"
    ? (input.employeeId ? [{ employeeId: input.employeeId, employeeName: input.employeeName }] : [])
    : (input.employeeParticipants ?? []);

  return withTransaction(db, () => {
    const existing = readConversationSync(id);
    if (existing) {
      for (const participant of employeeParticipants) {
        ensureConversationParticipantSync({
          conversationId: existing.id,
          participantType: "employee",
          employeeId: participant.employeeId,
          displayNameSnapshot: participant.employeeName,
          now,
        });
      }
      const lane = kind === "direct" && input.employeeId
        ? ensureExecutionLaneForConversationSync({
            workspaceId,
            conversationId: existing.id,
            employeeId: input.employeeId,
            employeeName: input.employeeName,
            kind,
            channelId: input.channelId,
            now,
          })
        : undefined;
      return { conversation: existing, lane };
    }

    db.prepare(
      `INSERT INTO conversation (
        id, workspace_id, kind, channel_id, created_by_user_id, status, title, summary,
        summary_source, last_message_at, last_activity_at, created_at, updated_at, archived_at, version
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 'fallback', NULL, ?, ?, ?, NULL, 0)`,
    ).run(
      id,
      workspaceId,
      kind,
      input.channelId ?? null,
      input.createdByUserId ?? null,
      input.title ?? null,
      input.summary ?? "新会话",
      now,
      now,
      now,
    );

    ensureConversationParticipantSync({
      conversationId: id,
      participantType: "human",
      userId: input.createdByUserId,
      displayNameSnapshot: undefined,
      now,
    });
    for (const participant of employeeParticipants) {
      ensureConversationParticipantSync({
        conversationId: id,
        participantType: "employee",
        employeeId: participant.employeeId,
        displayNameSnapshot: participant.employeeName,
        now,
      });
    }

    const lane = kind === "direct" && input.employeeId
      ? ensureExecutionLaneForConversationSync({
          workspaceId,
          conversationId: id,
          employeeId: input.employeeId,
          employeeName: input.employeeName,
          kind,
          channelId: input.channelId,
          now,
        })
      : undefined;

    const conversation = readConversationSync(id);
    if (!conversation) {
      throw new Error(`Conversation "${id}" could not be read after write.`);
    }
    return { conversation, lane };
  });
}

export function readConversationSync(id: string): ConversationRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS "workspaceId",
      kind,
      channel_id AS "channelId",
      created_by_user_id AS "createdByUserId",
      status,
      title,
      summary,
      summary_source AS "summarySource",
      last_message_at AS "lastMessageAt",
      last_activity_at AS "lastActivityAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      archived_at AS "archivedAt",
      version
     FROM conversation
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapConversationRecord(row) : null;
}

export interface ListConversationsOptions {
  workspaceId?: string;
  employeeId: string;
  statuses?: ConversationStatus[];
  cursor?: string;
  limit?: number;
  /** 仅返回该用户创建或参与的会话（跨用户信息隔离）。 */
  humanUserId?: string;
}

export function listConversationsForEmployeeSync(options: ListConversationsOptions): ConversationRecord[] {
  const db = getDatabase();
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = normalizeLimit(options.limit, 30);
  const where = [
    "conversation.workspace_id = ?",
    "conversation.id IN (SELECT conversation_id FROM conversation_participant WHERE employee_id = ?)",
  ];
  const params: unknown[] = [workspaceId, options.employeeId];
  if (options.humanUserId) {
    where.push(
      "(conversation.created_by_user_id = ? OR conversation.id IN (" +
        "SELECT conversation_id FROM conversation_participant WHERE participant_type = 'human' AND user_id = ?)" +
      ")",
    );
    params.push(options.humanUserId, options.humanUserId);
  }
  if (options.statuses && options.statuses.length > 0) {
    where.push(`conversation.status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  if (options.cursor) {
    where.push("(conversation.last_activity_at < ? OR (conversation.last_activity_at = ? AND conversation.id < ?))");
    const cursor = decodeConversationCursor(options.cursor);
    params.push(cursor.lastActivityAt, cursor.lastActivityAt, cursor.id);
  }
  const rows = db.prepare(
    `SELECT
      conversation.id,
      conversation.workspace_id AS "workspaceId",
      conversation.kind,
      conversation.channel_id AS "channelId",
      conversation.created_by_user_id AS "createdByUserId",
      conversation.status,
      conversation.title,
      conversation.summary,
      conversation.summary_source AS "summarySource",
      conversation.last_message_at AS "lastMessageAt",
      conversation.last_activity_at AS "lastActivityAt",
      conversation.created_at AS "createdAt",
      conversation.updated_at AS "updatedAt",
      conversation.archived_at AS "archivedAt",
      conversation.version
     FROM conversation
     WHERE ${where.join(" AND ")}
     ORDER BY conversation.last_activity_at DESC, conversation.id DESC
     LIMIT ?`,
  ).all(...params, limit + 1) as Array<Record<string, unknown>>;
  const records = rows.map(mapConversationRecord).filter((row): row is ConversationRecord => row !== null);
  return records.slice(0, limit);
}

export interface ListConversationsForChannelOptions {
  workspaceId?: string;
  channelId: string;
  statuses?: ConversationStatus[];
  cursor?: string;
  limit?: number;
  humanUserId?: string;
}

/** 群聊 Conversation 按 channel 列表（docs §5.2 的 group 场景）。 */
export function listConversationsForChannelSync(options: ListConversationsForChannelOptions): ConversationRecord[] {
  const db = getDatabase();
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const limit = normalizeLimit(options.limit, 30);
  const where = [
    "conversation.workspace_id = ?",
    "conversation.channel_id = ?",
    "conversation.kind = 'group'",
  ];
  const params: unknown[] = [workspaceId, options.channelId];
  if (options.humanUserId) {
    where.push(
      "(conversation.created_by_user_id = ? OR conversation.id IN (" +
        "SELECT conversation_id FROM conversation_participant WHERE participant_type = 'human' AND user_id = ?)" +
      ")",
    );
    params.push(options.humanUserId, options.humanUserId);
  }
  if (options.statuses && options.statuses.length > 0) {
    where.push(`conversation.status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  if (options.cursor) {
    where.push("(conversation.last_activity_at < ? OR (conversation.last_activity_at = ? AND conversation.id < ?))");
    const cursor = decodeConversationCursor(options.cursor);
    params.push(cursor.lastActivityAt, cursor.lastActivityAt, cursor.id);
  }
  const rows = db.prepare(
    `SELECT
      conversation.id,
      conversation.workspace_id AS "workspaceId",
      conversation.kind,
      conversation.channel_id AS "channelId",
      conversation.created_by_user_id AS "createdByUserId",
      conversation.status,
      conversation.title,
      conversation.summary,
      conversation.summary_source AS "summarySource",
      conversation.last_message_at AS "lastMessageAt",
      conversation.last_activity_at AS "lastActivityAt",
      conversation.created_at AS "createdAt",
      conversation.updated_at AS "updatedAt",
      conversation.archived_at AS "archivedAt",
      conversation.version
     FROM conversation
     WHERE ${where.join(" AND ")}
     ORDER BY conversation.last_activity_at DESC, conversation.id DESC
     LIMIT ?`,
  ).all(...params, limit + 1) as Array<Record<string, unknown>>;
  const records = rows.map(mapConversationRecord).filter((row): row is ConversationRecord => row !== null);
  return records.slice(0, limit);
}

export function encodeConversationCursor(input: { id: string; lastActivityAt?: string }): string {
  return Buffer.from(JSON.stringify({ id: input.id, lastActivityAt: input.lastActivityAt ?? "" })).toString("base64url");
}

export interface UpdateConversationInput {
  conversationId: string;
  expectedVersion?: number;
  title?: string | null;
  summary?: string | null;
  summarySource?: ConversationSummarySource;
  status?: ConversationStatus;
  lastMessageAt?: string | null;
  lastActivityAt?: string | null;
  archivedAt?: string | null;
  now?: string;
}

export function updateConversationSync(input: UpdateConversationInput): ConversationRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const previous = readConversationSync(input.conversationId);
  if (!previous) {
    throw new Error(`Conversation "${input.conversationId}" does not exist.`);
  }
  const expectedVersion = input.expectedVersion ?? previous.version;
  const result = db.prepare(
    `UPDATE conversation
     SET title = COALESCE(?, title),
         summary = COALESCE(?, summary),
         summary_source = COALESCE(?, summary_source),
         status = COALESCE(?, status),
         last_message_at = COALESCE(?, last_message_at),
         last_activity_at = COALESCE(?, last_activity_at),
         archived_at = ?,
         version = version + 1,
         updated_at = ?
     WHERE id = ? AND version = ?`,
  ).run(
    input.title ?? null,
    input.summary ?? null,
    input.summarySource ?? null,
    input.status ?? null,
    input.lastMessageAt ?? null,
    input.lastActivityAt ?? null,
    input.archivedAt === null ? null : (input.archivedAt ?? previous.archivedAt ?? null),
    now,
    input.conversationId,
    expectedVersion,
  );
  if (result.changes === 0) {
    throw new Error(`Conversation "${input.conversationId}" was updated concurrently; retry.`);
  }
  const conversation = readConversationSync(input.conversationId);
  if (!conversation) {
    throw new Error(`Conversation "${input.conversationId}" could not be read after write.`);
  }
  return conversation;
}

export function markConversationActiveSync(conversationId: string, options?: { now?: string }): ConversationRecord {
  const conversation = readConversationSync(conversationId);
  if (!conversation) {
    throw new Error(`Conversation "${conversationId}" does not exist.`);
  }
  if (conversation.status !== "draft") {
    return conversation;
  }
  const now = options?.now ?? new Date().toISOString();
  return updateConversationSync({
    conversationId,
    status: "active",
    lastMessageAt: conversation.lastMessageAt ?? now,
    lastActivityAt: now,
    summarySource: "fallback",
    now,
  });
}

export function archiveConversationSync(conversationId: string): ConversationRecord {
  return updateConversationSync({ conversationId, status: "archived", archivedAt: new Date().toISOString() });
}

export function unarchiveConversationSync(conversationId: string): ConversationRecord {
  return updateConversationSync({ conversationId, status: "idle", archivedAt: null });
}

export function ensureConversationParticipantSync(input: {
  conversationId: string;
  participantType: ConversationParticipantType;
  userId?: string;
  employeeId?: string;
  displayNameSnapshot?: string;
  now?: string;
}): ConversationParticipantRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const identityKey = input.participantType === "human"
    ? (input.userId ?? "")
    : (input.employeeId ?? "");
  const id = `participant-${createHash("sha256").update(`${input.conversationId}|${input.participantType}|${identityKey}`).digest("hex").slice(0, 32)}`;
  db.prepare(
    `INSERT INTO conversation_participant (
      id, conversation_id, participant_type, user_id, employee_id, display_name_snapshot, joined_at, left_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (id) DO UPDATE SET
      display_name_snapshot = COALESCE(excluded.display_name_snapshot, conversation_participant.display_name_snapshot),
      left_at = NULL`,
  ).run(
    id,
    input.conversationId,
    input.participantType,
    input.userId ?? null,
    input.employeeId ?? null,
    input.displayNameSnapshot ?? null,
    now,
  );
  const record = readConversationParticipantSync(id);
  if (!record) {
    throw new Error(`Participant "${id}" could not be read after write.`);
  }
  return record;
}

export type ConversationRunState = "running" | "queued" | "capacity_wait" | "failed" | "idle";

/** 从任务的 active/queued/failed 投影 Conversation 运行状态（docs 03 §8）。 */
export function projectConversationRunStateSync(conversationId: string): ConversationRunState {
  const rows = getDatabase().prepare(
    "SELECT status FROM agent_task_queue WHERE conversation_id = ? AND status IN ('queued', 'claimed', 'running', 'preparing_commit', 'failed')",
  ).all(conversationId) as Array<{ status?: string }>;
  const statuses = new Set(rows.map((row) => row.status).filter((status): status is string => Boolean(status)));
  if (statuses.has("running") || statuses.has("claimed") || statuses.has("preparing_commit")) {
    return "running";
  }
  if (statuses.has("failed")) {
    return "failed";
  }
  if (statuses.has("queued")) {
    return "queued";
  }
  return "idle";
}

export function listConversationParticipantsSync(conversationId: string): ConversationParticipantRecord[] {
  const rows = getDatabase().prepare(
    `SELECT
      id,
      conversation_id AS "conversationId",
      participant_type AS "participantType",
      user_id AS "userId",
      employee_id AS "employeeId",
      display_name_snapshot AS "displayNameSnapshot",
      joined_at AS "joinedAt",
      left_at AS "leftAt"
     FROM conversation_participant
     WHERE conversation_id = ? AND left_at IS NULL
     ORDER BY joined_at ASC, id ASC`,
  ).all(conversationId) as Array<Record<string, unknown>>;
  return rows.map(mapConversationParticipantRecord).filter((row): row is ConversationParticipantRecord => row !== null);
}

export function readConversationParticipantSync(id: string): ConversationParticipantRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      conversation_id AS "conversationId",
      participant_type AS "participantType",
      user_id AS "userId",
      employee_id AS "employeeId",
      display_name_snapshot AS "displayNameSnapshot",
      joined_at AS "joinedAt",
      left_at AS "leftAt"
     FROM conversation_participant
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapConversationParticipantRecord(row) : null;
}

export interface EnsureExecutionLaneInput {
  workspaceId?: string;
  conversationId: string;
  employeeId: string;
  employeeName?: string;
  kind?: ConversationKind;
  channelId?: string;
  now?: string;
}

export function ensureExecutionLaneForConversationSync(input: EnsureExecutionLaneInput): ConversationExecutionLaneRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date().toISOString();

  return withTransaction(db, () => {
    const existing = readExecutionLaneForConversationEmployeeSync(workspaceId, input.conversationId, input.employeeId);
    if (existing) {
      return existing;
    }

    const routerSession = upsertAgentRouterSessionSync({
      workspaceId,
      agentId: input.employeeId,
      conversationKey: `conversation:${input.conversationId}`,
      sourceType: input.kind === "direct" ? "direct_conversation" : "channel_conversation",
      title: input.employeeName,
      now,
    });

    const id = `lane-${randomLikeId()}`;
    db.prepare(
      `INSERT INTO conversation_execution_lane (
        id, workspace_id, conversation_id, employee_id, router_session_id,
        active_provider_session_id, work_dir, status, active_task_queue_id, last_error_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'idle', NULL, NULL, ?, ?)
      ON CONFLICT (workspace_id, conversation_id, employee_id) DO NOTHING`,
    ).run(id, workspaceId, input.conversationId, input.employeeId, routerSession.id, now, now);

    const lane = readExecutionLaneForConversationEmployeeSync(workspaceId, input.conversationId, input.employeeId);
    if (!lane) {
      throw new Error(`Execution lane for conversation "${input.conversationId}" employee "${input.employeeId}" could not be read after write.`);
    }
    return lane;
  });
}

export function readExecutionLaneSync(id: string): ConversationExecutionLaneRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS "workspaceId",
      conversation_id AS "conversationId",
      employee_id AS "employeeId",
      router_session_id AS "routerSessionId",
      active_provider_session_id AS "activeProviderSessionId",
      work_dir AS "workDir",
      status,
      active_task_queue_id AS "activeTaskQueueId",
      last_error_code AS "lastErrorCode",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
     FROM conversation_execution_lane
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapExecutionLaneRecord(row) : null;
}

export function readExecutionLaneForConversationEmployeeSync(
  workspaceId: string,
  conversationId: string,
  employeeId: string,
): ConversationExecutionLaneRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS "workspaceId",
      conversation_id AS "conversationId",
      employee_id AS "employeeId",
      router_session_id AS "routerSessionId",
      active_provider_session_id AS "activeProviderSessionId",
      work_dir AS "workDir",
      status,
      active_task_queue_id AS "activeTaskQueueId",
      last_error_code AS "lastErrorCode",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
     FROM conversation_execution_lane
     WHERE workspace_id = ? AND conversation_id = ? AND employee_id = ?`,
  ).get(workspaceId, conversationId, employeeId) as Record<string, unknown> | undefined;
  return row ? mapExecutionLaneRecord(row) : null;
}

export interface UpdateLaneInput {
  laneId: string;
  status?: ExecutionLaneStatus;
  activeProviderSessionId?: string | null;
  activeTaskQueueId?: string | null;
  workDir?: string | null;
  lastErrorCode?: string | null;
  now?: string;
}

export function updateExecutionLaneSync(input: UpdateLaneInput): ConversationExecutionLaneRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const previous = readExecutionLaneSync(input.laneId);
  if (!previous) {
    throw new Error(`Execution lane "${input.laneId}" does not exist.`);
  }
  db.prepare(
    `UPDATE conversation_execution_lane
     SET status = COALESCE(?, status),
         active_provider_session_id = ?,
         active_task_queue_id = ?,
         work_dir = ?,
         last_error_code = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    input.status ?? null,
    input.activeProviderSessionId === null ? null : (input.activeProviderSessionId ?? previous.activeProviderSessionId ?? null),
    input.activeTaskQueueId === null ? null : (input.activeTaskQueueId ?? previous.activeTaskQueueId ?? null),
    input.workDir === null ? null : (input.workDir ?? previous.workDir ?? null),
    input.lastErrorCode === null ? null : (input.lastErrorCode ?? previous.lastErrorCode ?? null),
    now,
    input.laneId,
  );
  const lane = readExecutionLaneSync(input.laneId);
  if (!lane) {
    throw new Error(`Execution lane "${input.laneId}" could not be read after write.`);
  }
  return lane;
}

export interface UpsertLaneProviderSessionInput {
  executionLaneId: string;
  provider: string;
  runtimeId?: string;
  providerSessionId: string;
  status?: ConversationProviderSessionStatus;
  now?: string;
}

export function upsertLaneProviderSessionSync(input: UpsertLaneProviderSessionInput): ConversationProviderSessionRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const providerSessionId = input.providerSessionId.trim();
  if (!providerSessionId) {
    throw new Error("providerSessionId is required.");
  }
  const existing = db.prepare(
    `SELECT id FROM conversation_provider_session
     WHERE execution_lane_id = ? AND provider = ? AND provider_session_id = ?
     LIMIT 1`,
  ).get(input.executionLaneId, input.provider, providerSessionId) as Record<string, unknown> | undefined;
  const id = typeof existing?.id === "string" ? existing.id : `lane-provider-session-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO conversation_provider_session (
      id, execution_lane_id, provider, runtime_id, provider_session_id, status,
      started_at, last_used_at, invalidated_at, invalid_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      runtime_id = COALESCE(excluded.runtime_id, conversation_provider_session.runtime_id),
      status = excluded.status,
      last_used_at = excluded.last_used_at,
      updated_at = excluded.updated_at`,
  ).run(
    id,
    input.executionLaneId,
    input.provider,
    input.runtimeId ?? null,
    providerSessionId,
    input.status ?? "active",
    existing ? null : now,
    now,
    now,
    now,
  );
  const record = readConversationProviderSessionSync(id);
  if (!record) {
    throw new Error(`Provider session "${id}" could not be read after write.`);
  }
  return record;
}

export function findActiveProviderSessionForLaneSync(input: {
  executionLaneId: string;
  provider?: string;
  runtimeId?: string;
}): ConversationProviderSessionRecord | null {
  const where = ["execution_lane_id = ?", "status = 'active'"];
  const params: unknown[] = [input.executionLaneId];
  if (input.provider) {
    where.push("provider = ?");
    params.push(input.provider);
  }
  if (input.runtimeId) {
    where.push("(runtime_id IS NULL OR runtime_id = ?)");
    params.push(input.runtimeId);
  }
  const row = getDatabase().prepare(
    `SELECT
      id,
      execution_lane_id AS "executionLaneId",
      provider,
      runtime_id AS "runtimeId",
      provider_session_id AS "providerSessionId",
      status,
      started_at AS "startedAt",
      last_used_at AS "lastUsedAt",
      invalidated_at AS "invalidatedAt",
      invalid_reason AS "invalidReason",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
     FROM conversation_provider_session
     WHERE ${where.join(" AND ")}
     ORDER BY last_used_at DESC, updated_at DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? mapProviderSessionRecord(row) : null;
}

export function readConversationProviderSessionSync(id: string): ConversationProviderSessionRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      execution_lane_id AS "executionLaneId",
      provider,
      runtime_id AS "runtimeId",
      provider_session_id AS "providerSessionId",
      status,
      started_at AS "startedAt",
      last_used_at AS "lastUsedAt",
      invalidated_at AS "invalidatedAt",
      invalid_reason AS "invalidReason",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
     FROM conversation_provider_session
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapProviderSessionRecord(row) : null;
}

export function markLaneProviderSessionInvalidSync(input: {
  executionLaneId: string;
  providerSessionId?: string;
  reason: string;
  now?: string;
}): void {
  const now = input.now ?? new Date().toISOString();
  const where = ["execution_lane_id = ?"];
  const params: unknown[] = [input.executionLaneId];
  if (input.providerSessionId) {
    where.push("provider_session_id = ?");
    params.push(input.providerSessionId);
  }
  getDatabase().prepare(
    `UPDATE conversation_provider_session
     SET status = 'invalid', invalidated_at = ?, invalid_reason = ?, updated_at = ?
     WHERE ${where.join(" AND ")}`,
  ).run(now, input.reason, now, ...params);
}

// ── Mapping helpers ──────────────────────────────────────────────────

function mapConversationRecord(value: Record<string, unknown>): ConversationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !isConversationKind(value.kind) ||
    !isConversationStatus(value.status) ||
    !isConversationSummarySource(value.summarySource) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.version !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    kind: value.kind,
    channelId: optionalString(value.channelId),
    createdByUserId: optionalString(value.createdByUserId),
    status: value.status,
    title: optionalString(value.title),
    summary: optionalString(value.summary),
    summarySource: value.summarySource,
    lastMessageAt: optionalString(value.lastMessageAt),
    lastActivityAt: optionalString(value.lastActivityAt),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: optionalString(value.archivedAt),
    version: value.version,
  };
}

function mapConversationParticipantRecord(value: Record<string, unknown>): ConversationParticipantRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.conversationId !== "string" ||
    !isParticipantType(value.participantType) ||
    typeof value.joinedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    conversationId: value.conversationId,
    participantType: value.participantType,
    userId: optionalString(value.userId),
    employeeId: optionalString(value.employeeId),
    displayNameSnapshot: optionalString(value.displayNameSnapshot),
    joinedAt: value.joinedAt,
    leftAt: optionalString(value.leftAt),
  };
}

function mapExecutionLaneRecord(value: Record<string, unknown>): ConversationExecutionLaneRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.employeeId !== "string" ||
    !isLaneStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    conversationId: value.conversationId,
    employeeId: value.employeeId,
    routerSessionId: optionalString(value.routerSessionId),
    activeProviderSessionId: optionalString(value.activeProviderSessionId),
    workDir: optionalString(value.workDir),
    status: value.status,
    activeTaskQueueId: optionalString(value.activeTaskQueueId),
    lastErrorCode: optionalString(value.lastErrorCode),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapProviderSessionRecord(value: Record<string, unknown>): ConversationProviderSessionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.executionLaneId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.providerSessionId !== "string" ||
    !isProviderSessionStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    executionLaneId: value.executionLaneId,
    provider: value.provider,
    runtimeId: optionalString(value.runtimeId),
    providerSessionId: value.providerSessionId,
    status: value.status,
    startedAt: optionalString(value.startedAt),
    lastUsedAt: optionalString(value.lastUsedAt),
    invalidatedAt: optionalString(value.invalidatedAt),
    invalidReason: optionalString(value.invalidReason),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function decodeConversationCursor(cursor: string): { id: string; lastActivityAt: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      id: typeof parsed.id === "string" ? parsed.id : "",
      lastActivityAt: typeof parsed.lastActivityAt === "string" ? parsed.lastActivityAt : "",
    };
  } catch {
    return { id: "", lastActivityAt: "" };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeLimit(limit: number | undefined, defaultLimit: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return defaultLimit;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function isConversationStatus(value: unknown): value is ConversationStatus {
  return value === "draft" || value === "active" || value === "idle" || value === "failed" || value === "archived" || value === "abandoned";
}

function isConversationKind(value: unknown): value is ConversationKind {
  return value === "direct" || value === "group";
}

function isConversationSummarySource(value: unknown): value is ConversationSummarySource {
  return value === "fallback" || value === "generated" || value === "user";
}

function isParticipantType(value: unknown): value is ConversationParticipantType {
  return value === "human" || value === "employee";
}

function isLaneStatus(value: unknown): value is ExecutionLaneStatus {
  return value === "idle" || value === "queued" || value === "running" || value === "capacity_wait" || value === "failed" || value === "stopped";
}

function isProviderSessionStatus(value: unknown): value is ConversationProviderSessionStatus {
  return value === "active" || value === "invalid" || value === "superseded" || value === "closed";
}
