import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import type {
  WorkspaceNotificationActorType,
  WorkspaceNotificationRecord,
  WorkspaceNotificationRecipientType,
  WorkspaceNotificationResourceType,
  WorkspaceNotificationSeverity,
  WorkspaceNotificationStatus,
} from "./types.ts";

export interface CreateWorkspaceNotificationInput {
  workspaceId?: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
  actorType?: WorkspaceNotificationActorType;
  actorId?: string;
  type: string;
  resourceType: WorkspaceNotificationResourceType;
  resourceId?: string;
  channelName?: string;
  title: string;
  body: string;
  actionHref?: string;
  severity?: WorkspaceNotificationSeverity;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ListWorkspaceNotificationsOptions {
  workspaceId?: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
  status?: WorkspaceNotificationStatus | WorkspaceNotificationStatus[];
  includeArchived?: boolean;
  limit?: number;
}

export interface WorkspaceNotificationRecipient {
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
}

export function createWorkspaceNotificationSync(
  input: CreateWorkspaceNotificationInput,
): WorkspaceNotificationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.createdAt ?? new Date().toISOString();
  const id = `notification-${randomLikeId()}`;
  const recipientId = normalizeRequired(input.recipientId, "recipientId");
  const type = normalizeRequired(input.type, "type");
  const title = normalizeRequired(input.title, "title");
  const body = normalizeRequired(input.body, "body");
  const severity = normalizeSeverity(input.severity);
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const actorType = normalizeActorType(input.actorType);
  const actorId = normalizeOptional(input.actorId);
  const resourceType = normalizeResourceType(input.resourceType);
  const resourceId = normalizeOptional(input.resourceId);
  const channelName = normalizeOptional(input.channelName);
  const actionHref = normalizeOptional(input.actionHref);
  const dedupeKey = normalizeOptional(input.dedupeKey);

  if (!isRecipientType(input.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipientType}".`);
  }

  db.prepare(
    `INSERT INTO workspace_notification (
      id,
      workspace_id,
      recipient_type,
      recipient_id,
      actor_type,
      actor_id,
      type,
      resource_type,
      resource_id,
      channel_name,
      title,
      body,
      action_href,
      severity,
      status,
      dedupe_key,
      metadata_json,
      created_at,
      read_at,
      archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, NULL, NULL)
    ON CONFLICT(workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
      recipient_type = EXCLUDED.recipient_type,
      recipient_id = EXCLUDED.recipient_id,
      actor_type = EXCLUDED.actor_type,
      actor_id = EXCLUDED.actor_id,
      type = EXCLUDED.type,
      resource_type = EXCLUDED.resource_type,
      resource_id = EXCLUDED.resource_id,
      channel_name = EXCLUDED.channel_name,
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      action_href = EXCLUDED.action_href,
      severity = EXCLUDED.severity,
      metadata_json = EXCLUDED.metadata_json`,
  ).run(
    id,
    workspaceId,
    input.recipientType,
    recipientId,
    actorType ?? null,
    actorId ?? null,
    type,
    resourceType,
    resourceId ?? null,
    channelName ?? null,
    title,
    body,
    actionHref ?? null,
    severity,
    dedupeKey ?? null,
    metadataJson,
    now,
  );

  const record = dedupeKey
    ? readWorkspaceNotificationByDedupeKeySync(workspaceId, dedupeKey)
    : readWorkspaceNotificationSync(id, workspaceId);
  if (!record) {
    throw new Error("Notification could not be read after write.");
  }
  return record;
}

export function createWorkspaceNotificationsSync(
  inputs: CreateWorkspaceNotificationInput[],
): WorkspaceNotificationRecord[] {
  return inputs.map((input) => createWorkspaceNotificationSync(input));
}

export function listWorkspaceNotificationsForRecipientSync(
  options: ListWorkspaceNotificationsOptions,
): WorkspaceNotificationRecord[] {
  const db = getDatabase();
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const recipientId = normalizeRequired(options.recipientId, "recipientId");
  if (!isRecipientType(options.recipientType)) {
    throw new Error(`Invalid notification recipient type "${options.recipientType}".`);
  }

  const conditions = ["workspace_id = ?", "recipient_type = ?", "recipient_id = ?"];
  const params: unknown[] = [workspaceId, options.recipientType, recipientId];
  const statuses = normalizeStatusFilter(options.status);
  if (statuses.length > 0) {
    conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  } else if (!options.includeArchived) {
    conditions.push("status <> 'archived'");
  }
  const limit = normalizeLimit(options.limit);

  const rows = db.prepare(
    `${workspaceNotificationSelectSql()}
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map(mapWorkspaceNotificationRecord).filter((record): record is WorkspaceNotificationRecord => record !== null);
}

export function countUnreadWorkspaceNotificationsSync(input: {
  workspaceId?: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
}): number {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const recipientId = normalizeRequired(input.recipientId, "recipientId");
  if (!isRecipientType(input.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipientType}".`);
  }
  const row = db.prepare(
    `SELECT COUNT(*)::int AS count
     FROM workspace_notification
     WHERE workspace_id = ?
       AND recipient_type = ?
       AND recipient_id = ?
       AND status = 'unread'`,
  ).get(workspaceId, input.recipientType, recipientId) as { count?: number } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

export function markWorkspaceNotificationReadSync(input: {
  workspaceId?: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}): WorkspaceNotificationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  updateNotificationStatusForRecipient({
    workspaceId,
    notificationId: input.notificationId,
    recipient: input.recipient,
    status: "read",
    readAt: now,
  });
  return readWorkspaceNotificationForRecipientSync(workspaceId, input.notificationId, input.recipient);
}

export function archiveWorkspaceNotificationSync(input: {
  workspaceId?: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}): WorkspaceNotificationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  updateNotificationStatusForRecipient({
    workspaceId,
    notificationId: input.notificationId,
    recipient: input.recipient,
    status: "archived",
    archivedAt: now,
  });
  return readWorkspaceNotificationForRecipientSync(workspaceId, input.notificationId, input.recipient);
}

function updateNotificationStatusForRecipient(input: {
  workspaceId: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
  status: WorkspaceNotificationStatus;
  readAt?: string;
  archivedAt?: string;
}): void {
  const notificationId = normalizeRequired(input.notificationId, "notificationId");
  const recipientId = normalizeRequired(input.recipient.recipientId, "recipientId");
  if (!isRecipientType(input.recipient.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipient.recipientType}".`);
  }

  getDatabase().prepare(
    `UPDATE workspace_notification
     SET status = ?,
         read_at = COALESCE(read_at, ?),
         archived_at = COALESCE(archived_at, ?)
     WHERE workspace_id = ?
       AND id = ?
       AND recipient_type = ?
       AND recipient_id = ?`,
  ).run(
    input.status,
    input.readAt ?? null,
    input.archivedAt ?? null,
    input.workspaceId,
    notificationId,
    input.recipient.recipientType,
    recipientId,
  );
}

function readWorkspaceNotificationSync(
  notificationId: string,
  workspaceId: string,
): WorkspaceNotificationRecord | null {
  const row = getDatabase().prepare(
    `${workspaceNotificationSelectSql()}
     WHERE id = ? AND workspace_id = ?`,
  ).get(notificationId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapWorkspaceNotificationRecord(row) : null;
}

function readWorkspaceNotificationByDedupeKeySync(
  workspaceId: string,
  dedupeKey: string,
): WorkspaceNotificationRecord | null {
  const row = getDatabase().prepare(
    `${workspaceNotificationSelectSql()}
     WHERE workspace_id = ? AND dedupe_key = ?`,
  ).get(workspaceId, dedupeKey) as Record<string, unknown> | undefined;
  return row ? mapWorkspaceNotificationRecord(row) : null;
}

function readWorkspaceNotificationForRecipientSync(
  workspaceId: string,
  notificationId: string,
  recipient: WorkspaceNotificationRecipient,
): WorkspaceNotificationRecord | null {
  const row = getDatabase().prepare(
    `${workspaceNotificationSelectSql()}
     WHERE workspace_id = ?
       AND id = ?
       AND recipient_type = ?
       AND recipient_id = ?`,
  ).get(workspaceId, notificationId, recipient.recipientType, recipient.recipientId) as Record<string, unknown> | undefined;
  return row ? mapWorkspaceNotificationRecord(row) : null;
}

function workspaceNotificationSelectSql(): string {
  return `SELECT
    id,
    workspace_id AS workspaceId,
    recipient_type AS recipientType,
    recipient_id AS recipientId,
    actor_type AS actorType,
    actor_id AS actorId,
    type,
    resource_type AS resourceType,
    resource_id AS resourceId,
    channel_name AS channelName,
    title,
    body,
    action_href AS actionHref,
    severity,
    status,
    dedupe_key AS dedupeKey,
    metadata_json AS metadataJson,
    created_at AS createdAt,
    read_at AS readAt,
    archived_at AS archivedAt
   FROM workspace_notification`;
}

function mapWorkspaceNotificationRecord(value: Record<string, unknown>): WorkspaceNotificationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !isRecipientType(value.recipientType) ||
    typeof value.recipientId !== "string" ||
    typeof value.type !== "string" ||
    !isResourceType(value.resourceType) ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    !isSeverity(value.severity) ||
    !isStatus(value.status) ||
    !isRecordMetadataJson(value.metadataJson) ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    recipientType: value.recipientType,
    recipientId: value.recipientId,
    actorType: isActorType(value.actorType) ? value.actorType : undefined,
    actorId: typeof value.actorId === "string" ? value.actorId : undefined,
    type: value.type,
    resourceType: value.resourceType,
    resourceId: typeof value.resourceId === "string" ? value.resourceId : undefined,
    channelName: typeof value.channelName === "string" ? value.channelName : undefined,
    title: value.title,
    body: value.body,
    actionHref: typeof value.actionHref === "string" ? value.actionHref : undefined,
    severity: value.severity,
    status: value.status,
    dedupeKey: typeof value.dedupeKey === "string" ? value.dedupeKey : undefined,
    metadataJson: normalizeMetadataJson(value.metadataJson),
    createdAt: value.createdAt,
    readAt: typeof value.readAt === "string" ? value.readAt : undefined,
    archivedAt: typeof value.archivedAt === "string" ? value.archivedAt : undefined,
  };
}

function normalizeRequired(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }
  return trimmed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecordMetadataJson(value: unknown): boolean {
  return typeof value === "string" || (Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

function normalizeMetadataJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {});
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 100;
  }
  return Math.max(1, Math.min(Math.round(value), 500));
}

function normalizeStatusFilter(
  value: WorkspaceNotificationStatus | WorkspaceNotificationStatus[] | undefined,
): WorkspaceNotificationStatus[] {
  const statuses = Array.isArray(value) ? value : value ? [value] : [];
  return statuses.filter(isStatus);
}

function normalizeActorType(value: WorkspaceNotificationActorType | undefined): WorkspaceNotificationActorType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isActorType(value)) {
    throw new Error(`Invalid notification actor type "${value}".`);
  }
  return value;
}

function normalizeResourceType(value: WorkspaceNotificationResourceType): WorkspaceNotificationResourceType {
  if (!isResourceType(value)) {
    throw new Error(`Invalid notification resource type "${value}".`);
  }
  return value;
}

function normalizeSeverity(value: WorkspaceNotificationSeverity | undefined): WorkspaceNotificationSeverity {
  if (value === undefined) {
    return "info";
  }
  if (!isSeverity(value)) {
    throw new Error(`Invalid notification severity "${value}".`);
  }
  return value;
}

function isRecipientType(value: unknown): value is WorkspaceNotificationRecipientType {
  return value === "human" || value === "agent";
}

function isActorType(value: unknown): value is WorkspaceNotificationActorType {
  return value === "human" || value === "agent" || value === "system";
}

function isResourceType(value: unknown): value is WorkspaceNotificationResourceType {
  return (
    value === "workspace" ||
    value === "workspace_member" ||
    value === "agent" ||
    value === "agent_fork_invitation" ||
    value === "channel" ||
    value === "document" ||
    value === "runtime" ||
    value === "task" ||
    value === "approval" ||
    value === "data_protection" ||
    value === "skill"
  );
}

function isSeverity(value: unknown): value is WorkspaceNotificationSeverity {
  return value === "info" || value === "success" || value === "warning" || value === "critical";
}

function isStatus(value: unknown): value is WorkspaceNotificationStatus {
  return value === "unread" || value === "read" || value === "archived";
}
