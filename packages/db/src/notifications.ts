import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId } from "./database.ts";
import { getPrismaClient } from "./prisma/client.ts";
import { toIsoString, toJsonString, toOptionalString } from "./prisma/runtime-mappers.ts";
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

// ---------------------------------------------------------------------------
// Phase 2 async Prisma repository (Route B).
//
// Coexists with the *Sync functions above and returns the SAME
// `WorkspaceNotificationRecord` DTO. FIDELITY READS use `$queryRawUnsafe` with
// `::text` casts on every timestamptz (`created_at`/`read_at`/`archived_at`) and
// the jsonb (`metadata_json`) column — @prisma/adapter-pg relabels timestamptz
// offsets without shifting wall-clock digits (wrong under a non-UTC session) and
// parses jsonb into a compact object; selecting `::text` and routing through
// `toIsoString` / `toJsonString` reproduces the sync worker's output byte-for-byte.
// WRITES (create dedupe-upsert, mark/archived with COALESCE) use raw SQL to
// preserve the partial-unique `ON CONFLICT ... WHERE dedupe_key IS NOT NULL` and
// the `COALESCE(read_at, ?)` non-destructive semantics that typed Prisma cannot
// express. See prisma/runtime-mappers.ts for the full rationale. Identifiers are
// a hardcoded whitelist; only values are parameterized (`$1..$N`).
// ---------------------------------------------------------------------------

type PrismaWorkspaceNotificationRow = {
  id: string;
  workspace_id: string;
  recipient_type: string;
  recipient_id: string;
  actor_type: string | null;
  actor_id: string | null;
  type: string;
  resource_type: string;
  resource_id: string | null;
  channel_name: string | null;
  title: string;
  body: string;
  action_href: string | null;
  severity: string;
  status: string;
  dedupe_key: string | null;
  metadata_json: string;
  created_at: string;
  read_at: string | null;
  archived_at: string | null;
};

/** Shared column list with fidelity casts on the timestamp + jsonb columns. */
const WORKSPACE_NOTIFICATION_SELECT_COLUMNS =
  "id, workspace_id, recipient_type, recipient_id, actor_type, actor_id, type, " +
  "resource_type, resource_id, channel_name, title, body, action_href, severity, " +
  "status, dedupe_key, metadata_json::text AS metadata_json, " +
  "created_at::text AS created_at, read_at::text AS read_at, archived_at::text AS archived_at";

function mapWorkspaceNotificationFromPrisma(
  row: PrismaWorkspaceNotificationRow,
): WorkspaceNotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    recipientType: row.recipient_type as WorkspaceNotificationRecipientType,
    recipientId: row.recipient_id,
    actorType: isActorType(row.actor_type) ? row.actor_type : undefined,
    actorId: toOptionalString(row.actor_id),
    type: row.type,
    resourceType: row.resource_type as WorkspaceNotificationResourceType,
    resourceId: toOptionalString(row.resource_id),
    channelName: toOptionalString(row.channel_name),
    title: row.title,
    body: row.body,
    actionHref: toOptionalString(row.action_href),
    severity: row.severity as WorkspaceNotificationSeverity,
    status: row.status as WorkspaceNotificationStatus,
    dedupeKey: toOptionalString(row.dedupe_key),
    metadataJson: toJsonString(row.metadata_json),
    createdAt: toIsoString(row.created_at) ?? "",
    readAt: toIsoString(row.read_at) ?? undefined,
    archivedAt: toIsoString(row.archived_at) ?? undefined,
  };
}

async function readNotificationAsync(
  notificationId: string,
  workspaceId: string,
): Promise<WorkspaceNotificationRecord | null> {
  const sql =
    `SELECT ${WORKSPACE_NOTIFICATION_SELECT_COLUMNS} FROM workspace_notification ` +
    `WHERE id = $1 AND workspace_id = $2`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceNotificationRow[]>(sql, notificationId, workspaceId);
  return rows.length > 0 ? mapWorkspaceNotificationFromPrisma(rows[0]!) : null;
}

async function readNotificationByDedupeKeyAsync(
  workspaceId: string,
  dedupeKey: string,
): Promise<WorkspaceNotificationRecord | null> {
  const sql =
    `SELECT ${WORKSPACE_NOTIFICATION_SELECT_COLUMNS} FROM workspace_notification ` +
    `WHERE workspace_id = $1 AND dedupe_key = $2`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceNotificationRow[]>(sql, workspaceId, dedupeKey);
  return rows.length > 0 ? mapWorkspaceNotificationFromPrisma(rows[0]!) : null;
}

async function readNotificationForRecipientAsync(
  workspaceId: string,
  notificationId: string,
  recipient: WorkspaceNotificationRecipient,
): Promise<WorkspaceNotificationRecord | null> {
  const sql =
    `SELECT ${WORKSPACE_NOTIFICATION_SELECT_COLUMNS} FROM workspace_notification ` +
    `WHERE workspace_id = $1 AND id = $2 AND recipient_type = $3 AND recipient_id = $4`;
  const rows = await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceNotificationRow[]>(
    sql,
    workspaceId,
    notificationId,
    recipient.recipientType,
    recipient.recipientId,
  );
  return rows.length > 0 ? mapWorkspaceNotificationFromPrisma(rows[0]!) : null;
}

export async function createWorkspaceNotificationAsync(
  input: CreateWorkspaceNotificationInput,
): Promise<WorkspaceNotificationRecord> {
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

  // Raw INSERT ... ON CONFLICT mirrors the sync layer's partial-unique dedupe
  // upsert (idx_workspace_notification_dedupe WHERE dedupe_key IS NOT NULL),
  // which typed Prisma upsert cannot target.
  await getPrismaClient().$executeRawUnsafe(
    `INSERT INTO workspace_notification (
       id, workspace_id, recipient_type, recipient_id, actor_type, actor_id, type,
       resource_type, resource_id, channel_name, title, body, action_href, severity,
       status, dedupe_key, metadata_json, created_at, read_at, archived_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'unread', $15, $16, $17, NULL, NULL)
     ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
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

  // Re-read via the fidelity text-cast path (mirrors the sync create, which
  // reads by dedupeKey when present else by id).
  const record = dedupeKey
    ? await readNotificationByDedupeKeyAsync(workspaceId, dedupeKey)
    : await readNotificationAsync(id, workspaceId);
  if (!record) {
    throw new Error("createWorkspaceNotificationAsync: notification row missing immediately after write");
  }
  return record;
}

export async function createWorkspaceNotificationsAsync(
  inputs: CreateWorkspaceNotificationInput[],
): Promise<WorkspaceNotificationRecord[]> {
  const records: WorkspaceNotificationRecord[] = [];
  for (const input of inputs) {
    records.push(await createWorkspaceNotificationAsync(input));
  }
  return records;
}

export async function listWorkspaceNotificationsForRecipientAsync(
  options: ListWorkspaceNotificationsOptions,
): Promise<WorkspaceNotificationRecord[]> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const recipientId = normalizeRequired(options.recipientId, "recipientId");
  if (!isRecipientType(options.recipientType)) {
    throw new Error(`Invalid notification recipient type "${options.recipientType}".`);
  }

  const conditions = ["workspace_id = $1", "recipient_type = $2", "recipient_id = $3"];
  const params: unknown[] = [workspaceId, options.recipientType, recipientId];
  let next = 4;
  const statuses = normalizeStatusFilter(options.status);
  if (statuses.length > 0) {
    const placeholders = statuses.map(() => `$${next++}`).join(", ");
    conditions.push(`status IN (${placeholders})`);
    params.push(...statuses);
  } else if (!options.includeArchived) {
    conditions.push("status <> 'archived'");
  }
  const limit = normalizeLimit(options.limit);
  const limitParam = `$${next}`;
  params.push(limit);

  const sql =
    `SELECT ${WORKSPACE_NOTIFICATION_SELECT_COLUMNS} FROM workspace_notification ` +
    `WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ${limitParam}`;
  const rows =
    await getPrismaClient().$queryRawUnsafe<PrismaWorkspaceNotificationRow[]>(sql, ...params);
  return rows
    .map(mapWorkspaceNotificationFromPrisma)
    .filter((record): record is WorkspaceNotificationRecord => record !== null);
}

export async function countUnreadWorkspaceNotificationsAsync(input: {
  workspaceId?: string;
  recipientType: WorkspaceNotificationRecipientType;
  recipientId: string;
}): Promise<number> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const recipientId = normalizeRequired(input.recipientId, "recipientId");
  if (!isRecipientType(input.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipientType}".`);
  }
  const rows = await getPrismaClient().$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) AS count FROM workspace_notification
     WHERE workspace_id = $1 AND recipient_type = $2 AND recipient_id = $3 AND status = 'unread'`,
    workspaceId,
    input.recipientType,
    recipientId,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Async mirror of the sync `updateNotificationStatusForRecipient` helper. */
async function updateNotificationStatusForRecipientAsync(input: {
  workspaceId: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
  status: WorkspaceNotificationStatus;
  readAt?: string;
  archivedAt?: string;
}): Promise<void> {
  const notificationId = normalizeRequired(input.notificationId, "notificationId");
  const recipientId = normalizeRequired(input.recipient.recipientId, "recipientId");
  if (!isRecipientType(input.recipient.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipient.recipientType}".`);
  }
  // COALESCE preserves an existing read_at/archived_at across a later state
  // transition (e.g. archiving a previously-read notification keeps read_at).
  await getPrismaClient().$executeRawUnsafe(
    `UPDATE workspace_notification
     SET status = $1,
         read_at = COALESCE(read_at, $2),
         archived_at = COALESCE(archived_at, $3)
     WHERE workspace_id = $4 AND id = $5 AND recipient_type = $6 AND recipient_id = $7`,
    input.status,
    input.readAt ?? null,
    input.archivedAt ?? null,
    input.workspaceId,
    notificationId,
    input.recipient.recipientType,
    recipientId,
  );
}

export async function markWorkspaceNotificationReadAsync(input: {
  workspaceId?: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}): Promise<WorkspaceNotificationRecord | null> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  await updateNotificationStatusForRecipientAsync({
    workspaceId,
    notificationId: input.notificationId,
    recipient: input.recipient,
    status: "read",
    readAt: now,
  });
  return readNotificationForRecipientAsync(workspaceId, input.notificationId, input.recipient);
}

export async function archiveWorkspaceNotificationAsync(input: {
  workspaceId?: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}): Promise<WorkspaceNotificationRecord | null> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  await updateNotificationStatusForRecipientAsync({
    workspaceId,
    notificationId: input.notificationId,
    recipient: input.recipient,
    status: "archived",
    archivedAt: now,
  });
  return readNotificationForRecipientAsync(workspaceId, input.notificationId, input.recipient);
}
