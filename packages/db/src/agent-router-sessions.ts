import { getDatabase, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import type {
  AgentRouterActorType,
  AgentRouterContextSnapshotRecord,
  AgentRouterContextSnapshotType,
  AgentRouterEventRecord,
  AgentRouterProviderSessionRecord,
  AgentRouterProviderSessionStatus,
  AgentRouterSessionRecord,
  AgentRouterSessionStatus,
  AgentTaskAttemptRecord,
  AgentTaskAttemptStatus,
  AgentRuntimeRecord,
  QueuedTaskRecord,
} from "./types.ts";
import { readAgentRuntimeSync } from "./daemons.ts";

export interface AgentRouterConversationIdentity {
  conversationKey?: string;
  sourceType: string;
  title?: string;
}

export function resolveTaskRouterConversationIdentity(
  task: Pick<QueuedTaskRecord, "id" | "agentId" | "triggerType" | "inputJson" | "issueId">,
): AgentRouterConversationIdentity {
  const payload = safeParseJsonObject(task.inputJson);
  const channelName = readString(payload.channelName) ?? readString(payload.channel);
  const contactId = readString(payload.contactId);
  const title = readString(payload.title) ?? task.issueId ?? task.id;

  if ((task.triggerType === "channel_chat" || task.triggerType === "mention_chat" || contactId) && (channelName || contactId)) {
    const sourceType = contactId ? "direct_conversation" : "channel_conversation";
    return {
      conversationKey: `${sourceType}:${channelName ?? contactId}`,
      sourceType,
      title,
    };
  }

  if (task.issueId) {
    return {
      conversationKey: `workspace_task:${task.issueId}`,
      sourceType: "workspace_task",
      title,
    };
  }

  return {
    conversationKey: `task:${task.id}`,
    sourceType: "task",
    title,
  };
}

export function resolveRouterSessionForTaskSync(
  task: Pick<QueuedTaskRecord, "id" | "workspaceId" | "agentId" | "triggerType" | "inputJson" | "issueId">,
): AgentRouterSessionRecord {
  const identity = resolveTaskRouterConversationIdentity(task);
  return upsertAgentRouterSessionSync({
    workspaceId: task.workspaceId,
    agentId: task.agentId,
    conversationKey: identity.conversationKey,
    sourceType: identity.sourceType,
    title: identity.title,
  });
}

export function upsertAgentRouterSessionSync(input: {
  workspaceId?: string;
  agentId: string;
  conversationKey?: string;
  sourceType?: string;
  title?: string;
  summary?: string;
  memorySummary?: string;
}): AgentRouterSessionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const agentId = input.agentId.trim();
  const conversationKey = input.conversationKey?.trim() || undefined;
  const sourceType = input.sourceType?.trim() || "task";

  if (!agentId) {
    throw new Error("agentId is required.");
  }

  const existing = conversationKey
    ? db.prepare(
        `SELECT id
         FROM agent_router_session
         WHERE workspace_id = ? AND agent_id = ? AND conversation_key = ?
         LIMIT 1`,
      ).get(workspaceId, agentId, conversationKey) as Record<string, unknown> | undefined
    : undefined;
  const id = typeof existing?.id === "string" ? existing.id : `router-session-${randomLikeId()}`;

  if (existing) {
    db.prepare(
      `UPDATE agent_router_session
       SET source_type = ?,
           status = 'active',
           title = COALESCE(?, title),
           summary = COALESCE(?, summary),
           memory_summary = COALESCE(?, memory_summary),
           updated_at = ?,
           closed_at = NULL
       WHERE id = ?`,
    ).run(
      sourceType,
      input.title?.trim() || null,
      input.summary?.trim() || null,
      input.memorySummary?.trim() || null,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO agent_router_session (
        id,
        workspace_id,
        agent_id,
        conversation_key,
        source_type,
        status,
        title,
        summary,
        memory_summary,
        created_at,
        updated_at,
        closed_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      workspaceId,
      agentId,
      conversationKey ?? null,
      sourceType,
      input.title?.trim() || null,
      input.summary?.trim() || null,
      input.memorySummary?.trim() || null,
      now,
      now,
    );
  }

  const session = readAgentRouterSessionSync(id);
  if (!session) {
    throw new Error(`Router session "${id}" could not be read after write.`);
  }
  return session;
}

export function readAgentRouterSessionSync(id: string): AgentRouterSessionRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      agent_id AS agentId,
      conversation_key AS conversationKey,
      source_type AS sourceType,
      status,
      title,
      summary,
      memory_summary AS memorySummary,
      model_override AS modelOverride,
      model_override_source AS modelOverrideSource,
      model_override_set_at AS modelOverrideSetAt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      closed_at AS closedAt
     FROM agent_router_session
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapAgentRouterSessionRecord(row) : null;
}

export function readAgentRouterSessionForTaskSync(task: Pick<QueuedTaskRecord, "routerSessionId">): AgentRouterSessionRecord | null {
  return task.routerSessionId ? readAgentRouterSessionSync(task.routerSessionId) : null;
}

export function listAgentRouterSessionsSync(options: {
  workspaceId?: string;
  agentId?: string;
  limit?: number;
} = {}): AgentRouterSessionRecord[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.workspaceId) {
    where.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  if (options.agentId) {
    where.push("agent_id = ?");
    params.push(options.agentId);
  }
  const rows = db.prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      agent_id AS agentId,
      conversation_key AS conversationKey,
      source_type AS sourceType,
      status,
      title,
      summary,
      memory_summary AS memorySummary,
      model_override AS modelOverride,
      model_override_source AS modelOverrideSource,
      model_override_set_at AS modelOverrideSetAt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      closed_at AS closedAt
     FROM agent_router_session
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, normalizeLimit(options.limit, 200)) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRouterSessionRecord).filter((session): session is AgentRouterSessionRecord => session !== null);
}

export function updateAgentRouterSessionMemorySync(input: {
  routerSessionId: string;
  memorySummary?: string | null;
  summary?: string | null;
}): AgentRouterSessionRecord {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE agent_router_session
     SET memory_summary = COALESCE(?, memory_summary),
         summary = COALESCE(?, summary),
         updated_at = ?
     WHERE id = ?`,
  ).run(input.memorySummary ?? null, input.summary ?? null, now, input.routerSessionId);
  const session = readAgentRouterSessionSync(input.routerSessionId);
  if (!session) {
    throw new Error(`Router session "${input.routerSessionId}" does not exist.`);
  }
  return session;
}

export function setAgentRouterSessionModelOverrideSync(input: {
  routerSessionId: string;
  modelOverride: string;
  source?: string;
}): AgentRouterSessionRecord {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE agent_router_session
     SET model_override = ?,
         model_override_source = ?,
         model_override_set_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(input.modelOverride, input.source ?? "manual", now, now, input.routerSessionId);
  const session = readAgentRouterSessionSync(input.routerSessionId);
  if (!session) {
    throw new Error(`Router session "${input.routerSessionId}" does not exist.`);
  }
  return session;
}

export function clearAgentRouterSessionModelOverrideSync(routerSessionId: string): AgentRouterSessionRecord {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE agent_router_session
     SET model_override = NULL,
         model_override_source = NULL,
         model_override_set_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, routerSessionId);
  const session = readAgentRouterSessionSync(routerSessionId);
  if (!session) {
    throw new Error(`Router session "${routerSessionId}" does not exist.`);
  }
  return session;
}

export function upsertAgentRouterProviderSessionSync(input: {
  workspaceId?: string;
  routerSessionId: string;
  runtimeId: string;
  provider: AgentRuntimeRecord["provider"];
  providerSessionId: string;
  status?: AgentRouterProviderSessionStatus;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}): AgentRouterProviderSessionRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const providerSessionId = input.providerSessionId.trim();
  if (!providerSessionId) {
    throw new Error("providerSessionId is required.");
  }

  const existing = db.prepare(
    `SELECT id, created_at AS createdAt
     FROM agent_router_provider_session
     WHERE workspace_id = ? AND router_session_id = ? AND runtime_id = ? AND provider = ?
     LIMIT 1`,
  ).get(workspaceId, input.routerSessionId, input.runtimeId, input.provider) as Record<string, unknown> | undefined;
  const id = typeof existing?.id === "string" ? existing.id : `provider-session-${randomLikeId()}`;
  const createdAt = typeof existing?.createdAt === "string" ? existing.createdAt : now;

  db.prepare(
    `INSERT INTO agent_router_provider_session (
      id,
      workspace_id,
      router_session_id,
      runtime_id,
      provider,
      provider_session_id,
      status,
      last_used_at,
      last_error,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, router_session_id, runtime_id, provider) DO UPDATE SET
      provider_session_id = excluded.provider_session_id,
      status = excluded.status,
      last_used_at = excluded.last_used_at,
      last_error = excluded.last_error,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at`,
  ).run(
    id,
    workspaceId,
    input.routerSessionId,
    input.runtimeId,
    input.provider,
    providerSessionId,
    input.status ?? "active",
    now,
    input.lastError ?? null,
    JSON.stringify(input.metadata ?? {}),
    createdAt,
    now,
  );

  const providerSession = readAgentRouterProviderSessionSync(id);
  if (!providerSession) {
    throw new Error(`Provider session "${id}" could not be read after write.`);
  }
  return providerSession;
}

export function markAgentRouterProviderSessionInvalidSync(input: {
  workspaceId?: string;
  routerSessionId: string;
  runtimeId?: string;
  provider?: AgentRuntimeRecord["provider"];
  providerSessionId?: string;
  lastError: string;
}): void {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const where = ["workspace_id = ?", "router_session_id = ?"];
  const params: unknown[] = [workspaceId, input.routerSessionId];
  if (input.runtimeId) {
    where.push("runtime_id = ?");
    params.push(input.runtimeId);
  }
  if (input.provider) {
    where.push("provider = ?");
    params.push(input.provider);
  }
  if (input.providerSessionId) {
    where.push("provider_session_id = ?");
    params.push(input.providerSessionId);
  }
  db.prepare(
    `UPDATE agent_router_provider_session
     SET status = 'invalid',
         last_error = ?,
         updated_at = ?
     WHERE ${where.join(" AND ")}`,
  ).run(input.lastError, now, ...params);
}

export function readAgentRouterProviderSessionSync(id: string): AgentRouterProviderSessionRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      runtime_id AS runtimeId,
      provider,
      provider_session_id AS providerSessionId,
      status,
      last_used_at AS lastUsedAt,
      last_error AS lastError,
      metadata_json AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM agent_router_provider_session
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapAgentRouterProviderSessionRecord(row) : null;
}

export function findActiveProviderSessionForRouterSync(input: {
  workspaceId?: string;
  routerSessionId: string;
  runtimeId: string;
  provider: AgentRuntimeRecord["provider"];
}): AgentRouterProviderSessionRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      runtime_id AS runtimeId,
      provider,
      provider_session_id AS providerSessionId,
      status,
      last_used_at AS lastUsedAt,
      last_error AS lastError,
      metadata_json AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM agent_router_provider_session
     WHERE workspace_id = ?
       AND router_session_id = ?
       AND runtime_id = ?
       AND provider = ?
       AND status = 'active'
     ORDER BY last_used_at DESC, updated_at DESC
     LIMIT 1`,
  ).get(workspaceId, input.routerSessionId, input.runtimeId, input.provider) as Record<string, unknown> | undefined;
  return row ? mapAgentRouterProviderSessionRecord(row) : null;
}

export function listAgentRouterProviderSessionsSync(options: {
  workspaceId?: string;
  routerSessionId?: string;
  runtimeId?: string;
  provider?: AgentRuntimeRecord["provider"];
} = {}): AgentRouterProviderSessionRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.workspaceId) {
    where.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  if (options.routerSessionId) {
    where.push("router_session_id = ?");
    params.push(options.routerSessionId);
  }
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider);
  }
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      runtime_id AS runtimeId,
      provider,
      provider_session_id AS providerSessionId,
      status,
      last_used_at AS lastUsedAt,
      last_error AS lastError,
      metadata_json AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM agent_router_provider_session
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC, id DESC`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRouterProviderSessionRecord).filter((session): session is AgentRouterProviderSessionRecord => session !== null);
}

export function createAgentTaskAttemptSync(input: {
  workspaceId?: string;
  taskQueueId: string;
  routerSessionId: string;
  runtimeId: string;
  provider: AgentRuntimeRecord["provider"];
  providerSessionId?: string;
  status?: AgentTaskAttemptStatus;
  metadata?: Record<string, unknown>;
}): AgentTaskAttemptRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = `attempt-${randomLikeId()}`;
  const status = input.status ?? "claimed";
  db.prepare(
    `INSERT INTO agent_task_attempt (
      id,
      workspace_id,
      task_queue_id,
      router_session_id,
      runtime_id,
      provider,
      provider_session_id,
      status,
      started_at,
      finished_at,
      error_text,
      handoff_snapshot_id,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    input.taskQueueId,
    input.routerSessionId,
    input.runtimeId,
    input.provider,
    input.providerSessionId ?? null,
    status,
    status === "running" ? now : null,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  const attempt = readAgentTaskAttemptSync(id);
  if (!attempt) {
    throw new Error(`Task attempt "${id}" could not be read after write.`);
  }
  return attempt;
}

export function readAgentTaskAttemptSync(id: string): AgentTaskAttemptRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      task_queue_id AS taskQueueId,
      router_session_id AS routerSessionId,
      runtime_id AS runtimeId,
      provider,
      provider_session_id AS providerSessionId,
      status,
      started_at AS startedAt,
      finished_at AS finishedAt,
      error_text AS errorText,
      handoff_snapshot_id AS handoffSnapshotId,
      metadata_json AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM agent_task_attempt
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapAgentTaskAttemptRecord(row) : null;
}

export function readLatestAgentTaskAttemptForTaskSync(taskQueueId: string): AgentTaskAttemptRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      task_queue_id AS taskQueueId,
      router_session_id AS routerSessionId,
      runtime_id AS runtimeId,
      provider,
      provider_session_id AS providerSessionId,
      status,
      started_at AS startedAt,
      finished_at AS finishedAt,
      error_text AS errorText,
      handoff_snapshot_id AS handoffSnapshotId,
      metadata_json AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM agent_task_attempt
     WHERE task_queue_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(taskQueueId) as Record<string, unknown> | undefined;
  return row ? mapAgentTaskAttemptRecord(row) : null;
}

export function listAgentTaskAttemptsSync(options: {
  workspaceId?: string;
  taskQueueId?: string;
  routerSessionId?: string;
  limit?: number;
} = {}): AgentTaskAttemptRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.workspaceId) {
    where.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  if (options.taskQueueId) {
    where.push("task_queue_id = ?");
    params.push(options.taskQueueId);
  }
  if (options.routerSessionId) {
    where.push("router_session_id = ?");
    params.push(options.routerSessionId);
  }
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      task_queue_id AS taskQueueId,
      router_session_id AS routerSessionId,
      runtime_id AS runtimeId,
      provider,
      provider_session_id AS providerSessionId,
      status,
      started_at AS startedAt,
      finished_at AS finishedAt,
      error_text AS errorText,
      handoff_snapshot_id AS handoffSnapshotId,
      metadata_json AS metadataJson,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM agent_task_attempt
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  ).all(...params, normalizeLimit(options.limit, 200)) as Array<Record<string, unknown>>;
  return rows.map(mapAgentTaskAttemptRecord).filter((attempt): attempt is AgentTaskAttemptRecord => attempt !== null);
}

export function updateAgentTaskAttemptSync(input: {
  attemptId: string;
  status: AgentTaskAttemptStatus;
  providerSessionId?: string | null;
  errorText?: string | null;
  handoffSnapshotId?: string | null;
  metadata?: Record<string, unknown>;
}): AgentTaskAttemptRecord {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE agent_task_attempt
     SET status = ?,
         provider_session_id = COALESCE(?, provider_session_id),
         started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
         finished_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN COALESCE(finished_at, ?) ELSE finished_at END,
         error_text = COALESCE(?, error_text),
         handoff_snapshot_id = COALESCE(?, handoff_snapshot_id),
         metadata_json = COALESCE(?, metadata_json),
         updated_at = ?
     WHERE id = ?`,
  ).run(
    input.status,
    input.providerSessionId ?? null,
    input.status,
    now,
    input.status,
    now,
    input.errorText ?? null,
    input.handoffSnapshotId ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
    input.attemptId,
  );
  const attempt = readAgentTaskAttemptSync(input.attemptId);
  if (!attempt) {
    throw new Error(`Task attempt "${input.attemptId}" does not exist.`);
  }
  return attempt;
}

export function recordAgentRouterEventSync(input: {
  workspaceId?: string;
  routerSessionId: string;
  taskQueueId?: string;
  attemptId?: string;
  type: string;
  actorType: AgentRouterActorType;
  actorId?: string;
  runtimeId?: string;
  provider?: AgentRuntimeRecord["provider"];
  summary?: string;
  data?: Record<string, unknown>;
  createdAt?: string;
}): AgentRouterEventRecord {
  const db = getDatabase();
  const id = `router-event-${randomLikeId()}`;
  const now = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_router_event (
      id,
      workspace_id,
      router_session_id,
      task_queue_id,
      attempt_id,
      type,
      actor_type,
      actor_id,
      runtime_id,
      provider,
      summary,
      data_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    input.routerSessionId,
    input.taskQueueId ?? null,
    input.attemptId ?? null,
    input.type,
    input.actorType,
    input.actorId ?? null,
    input.runtimeId ?? null,
    input.provider ?? null,
    input.summary ?? null,
    JSON.stringify(input.data ?? {}),
    now,
  );
  const event = readAgentRouterEventSync(id);
  if (!event) {
    throw new Error(`Router event "${id}" could not be read after write.`);
  }
  return event;
}

export function readAgentRouterEventSync(id: string): AgentRouterEventRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      task_queue_id AS taskQueueId,
      attempt_id AS attemptId,
      type,
      actor_type AS actorType,
      actor_id AS actorId,
      runtime_id AS runtimeId,
      provider,
      summary,
      data_json AS dataJson,
      created_at AS createdAt
     FROM agent_router_event
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapAgentRouterEventRecord(row) : null;
}

export function listAgentRouterEventsSync(options: {
  workspaceId?: string;
  routerSessionId?: string;
  taskQueueId?: string;
  limit?: number;
  order?: "asc" | "desc";
} = {}): AgentRouterEventRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.workspaceId) {
    where.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  if (options.routerSessionId) {
    where.push("router_session_id = ?");
    params.push(options.routerSessionId);
  }
  if (options.taskQueueId) {
    where.push("task_queue_id = ?");
    params.push(options.taskQueueId);
  }
  const order = options.order === "desc" ? "DESC" : "ASC";
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      task_queue_id AS taskQueueId,
      attempt_id AS attemptId,
      type,
      actor_type AS actorType,
      actor_id AS actorId,
      runtime_id AS runtimeId,
      provider,
      summary,
      data_json AS dataJson,
      created_at AS createdAt
     FROM agent_router_event
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at ${order}, id ${order}
     LIMIT ?`,
  ).all(...params, normalizeLimit(options.limit, 300)) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRouterEventRecord).filter((event): event is AgentRouterEventRecord => event !== null);
}

export function createAgentRouterContextSnapshotSync(input: {
  workspaceId?: string;
  routerSessionId: string;
  taskQueueId?: string;
  snapshotType: AgentRouterContextSnapshotType;
  contentMarkdown: string;
  sourceEventIds?: string[];
}): AgentRouterContextSnapshotRecord {
  const db = getDatabase();
  const id = `router-snapshot-${randomLikeId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_router_context_snapshot (
      id,
      workspace_id,
      router_session_id,
      task_queue_id,
      snapshot_type,
      content_markdown,
      source_event_ids_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    input.routerSessionId,
    input.taskQueueId ?? null,
    input.snapshotType,
    input.contentMarkdown,
    JSON.stringify(input.sourceEventIds ?? []),
    now,
  );
  const snapshot = readAgentRouterContextSnapshotSync(id);
  if (!snapshot) {
    throw new Error(`Router context snapshot "${id}" could not be read after write.`);
  }
  return snapshot;
}

export function readAgentRouterContextSnapshotSync(id: string): AgentRouterContextSnapshotRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      task_queue_id AS taskQueueId,
      snapshot_type AS snapshotType,
      content_markdown AS contentMarkdown,
      source_event_ids_json AS sourceEventIdsJson,
      created_at AS createdAt
     FROM agent_router_context_snapshot
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapAgentRouterContextSnapshotRecord(row) : null;
}

export function readLatestAgentRouterContextSnapshotSync(input: {
  workspaceId?: string;
  routerSessionId: string;
  snapshotType?: AgentRouterContextSnapshotType;
}): AgentRouterContextSnapshotRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?", "router_session_id = ?"];
  const params: unknown[] = [workspaceId, input.routerSessionId];
  if (input.snapshotType) {
    where.push("snapshot_type = ?");
    params.push(input.snapshotType);
  }
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      router_session_id AS routerSessionId,
      task_queue_id AS taskQueueId,
      snapshot_type AS snapshotType,
      content_markdown AS contentMarkdown,
      source_event_ids_json AS sourceEventIdsJson,
      created_at AS createdAt
     FROM agent_router_context_snapshot
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? mapAgentRouterContextSnapshotRecord(row) : null;
}

export function chooseProviderSessionForTaskSync(input: {
  task: Pick<QueuedTaskRecord, "workspaceId" | "routerSessionId" | "runtimeId">;
}): AgentRouterProviderSessionRecord | null {
  if (!input.task.routerSessionId) {
    return null;
  }
  const runtime = readAgentRuntimeSync(input.task.runtimeId);
  if (!runtime || runtime.provider === "hermes") {
    return null;
  }
  return findActiveProviderSessionForRouterSync({
    workspaceId: input.task.workspaceId,
    routerSessionId: input.task.routerSessionId,
    runtimeId: input.task.runtimeId,
    provider: runtime.provider,
  });
}

function mapAgentRouterSessionRecord(value: Record<string, unknown>): AgentRouterSessionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.agentId !== "string" ||
    !isAgentRouterSessionStatus(value.status) ||
    typeof value.sourceType !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    conversationKey: typeof value.conversationKey === "string" ? value.conversationKey : undefined,
    sourceType: value.sourceType,
    status: value.status,
    title: typeof value.title === "string" ? value.title : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    memorySummary: typeof value.memorySummary === "string" ? value.memorySummary : undefined,
    modelOverride: typeof value.modelOverride === "string" ? value.modelOverride : undefined,
    modelOverrideSource: typeof value.modelOverrideSource === "string" ? value.modelOverrideSource : undefined,
    modelOverrideSetAt: typeof value.modelOverrideSetAt === "string" ? value.modelOverrideSetAt : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: typeof value.closedAt === "string" ? value.closedAt : undefined,
  };
}

function mapAgentRouterProviderSessionRecord(value: Record<string, unknown>): AgentRouterProviderSessionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.routerSessionId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.providerSessionId !== "string" ||
    !isAgentRouterProviderSessionStatus(value.status) ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    routerSessionId: value.routerSessionId,
    runtimeId: value.runtimeId,
    provider: value.provider as AgentRuntimeRecord["provider"],
    providerSessionId: value.providerSessionId,
    status: value.status,
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
    metadataJson: value.metadataJson,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapAgentTaskAttemptRecord(value: Record<string, unknown>): AgentTaskAttemptRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.taskQueueId !== "string" ||
    typeof value.routerSessionId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.provider !== "string" ||
    !isAgentTaskAttemptStatus(value.status) ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    taskQueueId: value.taskQueueId,
    routerSessionId: value.routerSessionId,
    runtimeId: value.runtimeId,
    provider: value.provider as AgentRuntimeRecord["provider"],
    providerSessionId: typeof value.providerSessionId === "string" ? value.providerSessionId : undefined,
    status: value.status,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : undefined,
    errorText: typeof value.errorText === "string" ? value.errorText : undefined,
    handoffSnapshotId: typeof value.handoffSnapshotId === "string" ? value.handoffSnapshotId : undefined,
    metadataJson: value.metadataJson,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapAgentRouterEventRecord(value: Record<string, unknown>): AgentRouterEventRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.routerSessionId !== "string" ||
    typeof value.type !== "string" ||
    !isAgentRouterActorType(value.actorType) ||
    typeof value.dataJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    routerSessionId: value.routerSessionId,
    taskQueueId: typeof value.taskQueueId === "string" ? value.taskQueueId : undefined,
    attemptId: typeof value.attemptId === "string" ? value.attemptId : undefined,
    type: value.type,
    actorType: value.actorType,
    actorId: typeof value.actorId === "string" ? value.actorId : undefined,
    runtimeId: typeof value.runtimeId === "string" ? value.runtimeId : undefined,
    provider: typeof value.provider === "string" ? value.provider as AgentRuntimeRecord["provider"] : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    dataJson: value.dataJson,
    createdAt: value.createdAt,
  };
}

function mapAgentRouterContextSnapshotRecord(value: Record<string, unknown>): AgentRouterContextSnapshotRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.routerSessionId !== "string" ||
    !isAgentRouterContextSnapshotType(value.snapshotType) ||
    typeof value.contentMarkdown !== "string" ||
    typeof value.sourceEventIdsJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    routerSessionId: value.routerSessionId,
    taskQueueId: typeof value.taskQueueId === "string" ? value.taskQueueId : undefined,
    snapshotType: value.snapshotType,
    contentMarkdown: value.contentMarkdown,
    sourceEventIdsJson: value.sourceEventIdsJson,
    createdAt: value.createdAt,
  };
}

function isAgentRouterSessionStatus(value: unknown): value is AgentRouterSessionStatus {
  return value === "active" || value === "closed";
}

function isAgentRouterProviderSessionStatus(value: unknown): value is AgentRouterProviderSessionStatus {
  return value === "active" || value === "invalid" || value === "expired";
}

function isAgentRouterActorType(value: unknown): value is AgentRouterActorType {
  return value === "human" || value === "agent" || value === "runtime" || value === "system";
}

function isAgentRouterContextSnapshotType(value: unknown): value is AgentRouterContextSnapshotType {
  return value === "context" || value === "memory" || value === "handoff";
}

function isAgentTaskAttemptStatus(value: unknown): value is AgentTaskAttemptStatus {
  return value === "claimed" || value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function normalizeLimit(limit: number | undefined, defaultLimit: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return defaultLimit;
  }
  return Math.min(1000, Math.max(1, Math.floor(limit)));
}

function safeParseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
