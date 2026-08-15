// notifications Phase 2 真 Prisma Client write path：
// createWorkspaceNotificationPrisma 复刻 sync createWorkspaceNotificationSync 的
// 归一化 + dedupe 语义；createWorkspaceNotificationPrismaCutover 通过
// buildDomainWriteCutover 工厂接线：
// - Flag OFF  → 直接走 sync createWorkspaceNotificationSync
// - Flag ON   → 走 Prisma primary；primary 抛错时 fail closed
// - primary 成功即返回（不并行 dual-write），事务结果不明确时不重写。
//
// dedupe 语义：source DB 的唯一性是 partial unique index
// ON CONFLICT(workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE，
// Prisma upsert 无法表达 partial index，故用
// updateMany（命中即覆盖 DO UPDATE SET 列集）→ create →
// 并发落败（P2002/23505）读回既有行，语义等价。

import type { Prisma, PrismaClient } from "@prisma/client";
import { randomLikeId } from "../database.ts";
import {
  archiveWorkspaceNotificationSync,
  createWorkspaceNotificationSync,
  markWorkspaceNotificationReadSync,
  type CreateWorkspaceNotificationInput,
} from "../notifications.ts";
import type {
  WorkspaceNotificationActorType,
  WorkspaceNotificationRecord,
  WorkspaceNotificationRecipient,
  WorkspaceNotificationRecipientType,
  WorkspaceNotificationResourceType,
  WorkspaceNotificationSeverity,
  WorkspaceNotificationStatus,
} from "../types.ts";
import {
  buildDomainWriteCutover,
  type DomainWriteCutoverMetric,
} from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
// Reuse the shared PrismaClient singleton + setter so mock injection covers
// read and write without duplicating the cache plumbing.
import { getDofePrismaClient } from "./prisma-client.ts";
import {
  disconnectNotificationsPrismaForTests,
  setNotificationsPrismaClientForTests,
} from "./notifications-prisma.ts";

export function isNotificationsPrismaWriteEnabled(): boolean {
  return process.env.NOTIFICATIONS_PRISMA_WRITE_ENABLED === "1";
}

// Re-export so callers (tests / shutdown paths) only import this module.
export { disconnectNotificationsPrismaForTests, setNotificationsPrismaClientForTests };

/**
 * Direct Prisma insert (with dedupe upsert semantics). Caller controls when
 * to invoke this (typically via the createWorkspaceNotificationPrismaCutover
 * wrapper). Returns the persisted row as read back from the primary.
 */
export async function createWorkspaceNotificationPrisma(
  input: CreateWorkspaceNotificationInput,
  client?: PrismaClient,
): Promise<WorkspaceNotificationRecord> {
  const prisma = client ?? getDofePrismaClient();
  const workspaceId = input.workspaceId ?? "default";
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = `notification-${randomLikeId()}`;

  const recipientId = normalizeRequired(input.recipientId, "recipientId");
  const type = normalizeRequired(input.type, "type");
  const title = normalizeRequired(input.title, "title");
  const body = normalizeRequired(input.body, "body");
  const severity = normalizeSeverity(input.severity);
  const actorType = normalizeActorType(input.actorType);
  const actorId = normalizeOptional(input.actorId);
  const resourceType = normalizeResourceType(input.resourceType);
  const resourceId = normalizeOptional(input.resourceId);
  const channelName = normalizeOptional(input.channelName);
  const actionHref = normalizeOptional(input.actionHref);
  const dedupeKey = normalizeOptional(input.dedupeKey);
  const metadataJson = toInputJsonValue(input.metadata);

  if (!isRecipientType(input.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipientType}".`);
  }

  const createData = {
    id,
    workspaceId,
    recipientType: input.recipientType,
    recipientId,
    actorType: actorType ?? null,
    actorId: actorId ?? null,
    type,
    resourceType,
    resourceId: resourceId ?? null,
    channelName: channelName ?? null,
    title,
    body,
    actionHref: actionHref ?? null,
    severity,
    status: "unread",
    dedupeKey: dedupeKey ?? null,
    metadataJson,
    createdAt: new Date(createdAt),
  } satisfies Prisma.WorkspaceNotificationCreateInput;

  if (dedupeKey) {
    // 与 sync ON CONFLICT DO UPDATE SET 的列集一致（不含 id/created_at/status/read_at/archived_at）。
    const conflictData = {
      recipientType: input.recipientType,
      recipientId,
      actorType: actorType ?? null,
      actorId: actorId ?? null,
      type,
      resourceType,
      resourceId: resourceId ?? null,
      channelName: channelName ?? null,
      title,
      body,
      actionHref: actionHref ?? null,
      severity,
      metadataJson,
    } satisfies Prisma.WorkspaceNotificationUpdateInput;
    const updated = await prisma.workspaceNotification.updateMany({
      where: { workspaceId, dedupeKey },
      data: conflictData,
    });
    if (updated.count === 0) {
      try {
        await prisma.workspaceNotification.create({ data: createData });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // 并发落败：另一写入方先插入了同 dedupe_key 行，落到下方读回。
      }
    }
  } else {
    await prisma.workspaceNotification.create({ data: createData });
  }

  const row = await prisma.workspaceNotification.findFirst({
    where: dedupeKey ? { workspaceId, dedupeKey } : { id, workspaceId },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    throw new Error("Notification could not be read after write.");
  }
  return mapRowToRecord(row);
}

export type CreateWorkspaceNotificationPrismaCutoverMetric = DomainWriteCutoverMetric;
export type CreateWorkspaceNotificationPrismaCutoverMetricSink = (
  metric: CreateWorkspaceNotificationPrismaCutoverMetric,
) => void;

const createWorkspaceNotificationPrismaCutoverImpl = buildDomainWriteCutover<
  CreateWorkspaceNotificationInput,
  WorkspaceNotificationRecord,
  CreateWorkspaceNotificationPrismaCutoverMetric
>({
  isEnabled: isNotificationsPrismaWriteEnabled,
  runPrimary: async (input) => createWorkspaceNotificationPrisma(input),
  runFallback: (input) => createWorkspaceNotificationSync(input),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workspace_notification",
    operation: "create",
  }),
});

/**
 * Write cutover for notifications: uses Prisma primary when the flag is on
 * and propagates ambiguous primary failures without attempting a second insert.
 */
export function createWorkspaceNotificationPrismaCutover(
  input: CreateWorkspaceNotificationInput,
  metricSink?: CreateWorkspaceNotificationPrismaCutoverMetricSink,
): Promise<WorkspaceNotificationRecord> {
  return createWorkspaceNotificationPrismaCutoverImpl(input, metricSink);
}

// ---------------------------------------------------------------------------
// markRead / archive 写路径：sync 的 UPDATE 用
// read_at = COALESCE(read_at, ?) / archived_at = COALESCE(archived_at, ?)
// 保留首次时间戳；Prisma updateMany 表达不了 COALESCE，用 $executeRaw 保真。
// ---------------------------------------------------------------------------

export interface NotificationStatusInput {
  workspaceId?: string;
  notificationId: string;
  recipient: WorkspaceNotificationRecipient;
}

export async function markWorkspaceNotificationReadPrisma(
  input: NotificationStatusInput,
  client?: PrismaClient,
): Promise<WorkspaceNotificationRecord | null> {
  return updateNotificationStatusForRecipientPrisma(input, "read", client);
}

export async function archiveWorkspaceNotificationPrisma(
  input: NotificationStatusInput,
  client?: PrismaClient,
): Promise<WorkspaceNotificationRecord | null> {
  return updateNotificationStatusForRecipientPrisma(input, "archived", client);
}

async function updateNotificationStatusForRecipientPrisma(
  input: NotificationStatusInput,
  status: Exclude<WorkspaceNotificationStatus, "unread">,
  client?: PrismaClient,
): Promise<WorkspaceNotificationRecord | null> {
  const prisma = client ?? getDofePrismaClient();
  const workspaceId = input.workspaceId ?? "default";
  const notificationId = normalizeRequired(input.notificationId, "notificationId");
  const recipientId = normalizeRequired(input.recipient.recipientId, "recipientId");
  if (!isRecipientType(input.recipient.recipientType)) {
    throw new Error(`Invalid notification recipient type "${input.recipient.recipientType}".`);
  }

  const now = new Date();
  await prisma.$executeRaw`UPDATE workspace_notification
     SET status = ${status},
         read_at = COALESCE(read_at, ${status === "read" ? now : null}),
         archived_at = COALESCE(archived_at, ${status === "archived" ? now : null})
     WHERE workspace_id = ${workspaceId}
       AND id = ${notificationId}
       AND recipient_type = ${input.recipient.recipientType}
       AND recipient_id = ${recipientId}`;

  const row = await prisma.workspaceNotification.findFirst({
    where: {
      workspaceId,
      id: notificationId,
      recipientType: input.recipient.recipientType,
      recipientId,
    },
  });
  return row ? mapRowToRecord(row) : null;
}

export type UpdateNotificationStatusPrismaCutoverMetric = DomainWriteCutoverMetric;
export type UpdateNotificationStatusPrismaCutoverMetricSink = (
  metric: UpdateNotificationStatusPrismaCutoverMetric,
) => void;

const markWorkspaceNotificationReadPrismaCutoverImpl = buildDomainWriteCutover<
  NotificationStatusInput,
  WorkspaceNotificationRecord | null,
  UpdateNotificationStatusPrismaCutoverMetric
>({
  isEnabled: isNotificationsPrismaWriteEnabled,
  runPrimary: async (input) => markWorkspaceNotificationReadPrisma(input),
  runFallback: (input) => markWorkspaceNotificationReadSync(input),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workspace_notification",
    operation: "mark_read",
  }),
});

const archiveWorkspaceNotificationPrismaCutoverImpl = buildDomainWriteCutover<
  NotificationStatusInput,
  WorkspaceNotificationRecord | null,
  UpdateNotificationStatusPrismaCutoverMetric
>({
  isEnabled: isNotificationsPrismaWriteEnabled,
  runPrimary: async (input) => archiveWorkspaceNotificationPrisma(input),
  runFallback: (input) => archiveWorkspaceNotificationSync(input),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "workspace_notification",
    operation: "archive",
  }),
});

/**
 * Write cutover for notification mark-read: Prisma primary when the flag is
 * on, sync fallback otherwise. Returns the updated row or null when absent.
 */
export function markWorkspaceNotificationReadPrismaCutover(
  input: NotificationStatusInput,
  metricSink?: UpdateNotificationStatusPrismaCutoverMetricSink,
): Promise<WorkspaceNotificationRecord | null> {
  return markWorkspaceNotificationReadPrismaCutoverImpl(input, metricSink);
}

/**
 * Write cutover for notification archive: Prisma primary when the flag is
 * on, sync fallback otherwise. Returns the updated row or null when absent.
 */
export function archiveWorkspaceNotificationPrismaCutover(
  input: NotificationStatusInput,
  metricSink?: UpdateNotificationStatusPrismaCutoverMetricSink,
): Promise<WorkspaceNotificationRecord | null> {
  return archiveWorkspaceNotificationPrismaCutoverImpl(input, metricSink);
}

function mapRowToRecord(row: {
  id: string;
  workspaceId: string;
  recipientType: string;
  recipientId: string;
  actorType: string | null;
  actorId: string | null;
  type: string;
  resourceType: string;
  resourceId: string | null;
  channelName: string | null;
  title: string;
  body: string;
  actionHref: string | null;
  severity: string;
  status: string;
  dedupeKey: string | null;
  metadataJson: unknown;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
}): WorkspaceNotificationRecord {
  const record: WorkspaceNotificationRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    recipientType: row.recipientType as WorkspaceNotificationRecipientType,
    recipientId: row.recipientId,
    type: row.type,
    resourceType: row.resourceType as WorkspaceNotificationResourceType,
    title: row.title,
    body: row.body,
    severity: row.severity as WorkspaceNotificationSeverity,
    status: row.status as WorkspaceNotificationRecord["status"],
    metadataJson: serializeJson(row.metadataJson),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.actorType !== null) {
    record.actorType = row.actorType as WorkspaceNotificationActorType;
  }
  if (row.actorId !== null) record.actorId = row.actorId;
  if (row.resourceId !== null) record.resourceId = row.resourceId;
  if (row.channelName !== null) record.channelName = row.channelName;
  if (row.actionHref !== null) record.actionHref = row.actionHref;
  if (row.dedupeKey !== null) record.dedupeKey = row.dedupeKey;
  if (row.readAt) record.readAt = row.readAt.toISOString();
  if (row.archivedAt) record.archivedAt = row.archivedAt.toISOString();
  return record;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // Prisma P2002（unique constraint）与 pg 23505（unique_violation）都算并发落败。
  return code === "P2002" || code === "23505";
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

function normalizeSeverity(value: WorkspaceNotificationSeverity | undefined): WorkspaceNotificationSeverity {
  if (value === undefined) {
    return "info";
  }
  if (!isSeverity(value)) {
    throw new Error(`Invalid notification severity "${value}".`);
  }
  return value;
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

function isRecipientType(value: unknown): value is WorkspaceNotificationRecipientType {
  return value === "human" || value === "agent";
}

function isActorType(value: unknown): value is WorkspaceNotificationActorType {
  return value === "human" || value === "agent" || value === "system";
}

const VALID_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "workspace",
  "workspace_member",
  "agent",
  "agent_fork_invitation",
  "channel",
  "document",
  "runtime",
  "task",
  "approval",
  "data_protection",
  "skill",
  "capability_request",
]);

function isResourceType(value: unknown): value is WorkspaceNotificationResourceType {
  return typeof value === "string" && VALID_RESOURCE_TYPES.has(value);
}

function isSeverity(value: unknown): value is WorkspaceNotificationSeverity {
  return (
    value === "info" || value === "success" || value === "warning" ||
    value === "critical" || value === "error"
  );
}

function toInputJsonValue(value: Record<string, unknown> | undefined): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function serializeJson(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
