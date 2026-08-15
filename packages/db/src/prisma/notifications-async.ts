// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 notifications-prisma.ts（同等接口，@prisma/client 真接入）。
//
// notifications Phase 2 异步 primary（pg.Client 直连原型）：
// - listWorkspaceNotificationsAsync 通过 pg.Client 直连 PG 拉
//   workspace_notification 行，作为 cutover runner 的 async primary。
// - shadow 关闭时无任何额外开销（不在 sync 路径上调用）。
// - mapAsyncNotificationRow / normalizeNotificationsLimit 为 cutover
//   wrapper 与单元测试所引用的具名导出；normalizeLimit 默认 100、
//   Math.round 处理小数输入、最小 1、最大 500。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { ListWorkspaceNotificationsOptions } from "../notifications.ts";
import type { WorkspaceNotificationRecord } from "../types.ts";

interface AsyncNotificationRow {
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
  metadata_json: unknown;
  created_at: Date | string;
  read_at: Date | string | null;
  archived_at: Date | string | null;
}

const RECIPIENT_TYPES = new Set(["human", "agent"]);
const ACTOR_TYPES = new Set(["human", "agent", "system"]);
const RESOURCE_TYPES = new Set([
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
const SEVERITIES = new Set(["info", "success", "warning", "critical", "error"]);
const STATUSES = new Set(["unread", "read", "archived"]);

export async function listWorkspaceNotificationsAsync(
  options: ListWorkspaceNotificationsOptions,
): Promise<WorkspaceNotificationRecord[]> {
  const workspaceId = options.workspaceId ?? "default";
  const recipientId = options.recipientId;
  const recipientType = options.recipientType;
  if (!recipientId) throw new Error("recipientId required");
  if (!RECIPIENT_TYPES.has(recipientType)) {
    throw new Error(`Invalid notification recipient type "${recipientType}".`);
  }

  const conditions: string[] = ["workspace_id = $1", "recipient_type = $2", "recipient_id = $3"];
  const params: unknown[] = [workspaceId, recipientType, recipientId];

  const statuses = normalizeStatusFilter(options.status);
  if (statuses.length > 0) {
    conditions.push(`status = ANY($${params.length + 1}::text[])`);
    params.push(statuses);
  } else if (!options.includeArchived) {
    conditions.push("status <> 'archived'");
  }
  const limit = normalizeNotificationsLimit(options.limit);
  params.push(limit);

  const sql = `SELECT id, workspace_id, recipient_type, recipient_id,
                      actor_type, actor_id, type, resource_type, resource_id,
                      channel_name, title, body, action_href, severity,
                      status, dedupe_key, metadata_json, created_at,
                      read_at, archived_at
               FROM workspace_notification
               WHERE ${conditions.join(" AND ")}
               ORDER BY created_at DESC, id DESC
               LIMIT $${params.length}`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<AsyncNotificationRow>(sql, params);
    return result.rows
      .map(mapAsyncNotificationRow)
      .filter((record): record is WorkspaceNotificationRecord => record !== null);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isNotificationsAsyncReadEnabled(): boolean {
  return process.env.NOTIFICATIONS_ASYNC_READ_ENABLED === "1";
}

export function isNotificationsShadowReadEnabled(): boolean {
  return process.env.NOTIFICATIONS_SHADOW_READ_ENABLED === "1";
}

export function normalizeNotificationsLimit(limit: number | undefined): number {
  const fallback = limit ?? 100;
  const rounded = Number.isFinite(fallback) ? Math.round(fallback) : 100;
  return Math.min(Math.max(rounded, 1), 500);
}

function normalizeStatusFilter(status: ListWorkspaceNotificationsOptions["status"]): string[] {
  if (!status) return [];
  if (Array.isArray(status)) return status.filter((s) => STATUSES.has(s));
  if (STATUSES.has(status)) return [status];
  return [];
}

export function mapAsyncNotificationRow(
  row: AsyncNotificationRow,
): WorkspaceNotificationRecord | null {
  if (!RECIPIENT_TYPES.has(row.recipient_type)) return null;
  if (!RESOURCE_TYPES.has(row.resource_type)) return null;
  if (!SEVERITIES.has(row.severity)) return null;
  if (!STATUSES.has(row.status)) return null;
  const record: WorkspaceNotificationRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    recipientType: row.recipient_type as WorkspaceNotificationRecord["recipientType"],
    recipientId: row.recipient_id,
    type: row.type,
    resourceType: row.resource_type as WorkspaceNotificationRecord["resourceType"],
    title: row.title,
    body: row.body,
    severity: row.severity as WorkspaceNotificationRecord["severity"],
    status: row.status as WorkspaceNotificationRecord["status"],
    metadataJson: serializeJson(row.metadata_json),
    createdAt: toIsoString(row.created_at),
  };
  if (row.actor_type && ACTOR_TYPES.has(row.actor_type)) {
    record.actorType = row.actor_type as WorkspaceNotificationRecord["actorType"];
  }
  if (row.actor_id !== null) record.actorId = row.actor_id;
  if (row.resource_id !== null) record.resourceId = row.resource_id;
  if (row.channel_name !== null) record.channelName = row.channel_name;
  if (row.action_href !== null) record.actionHref = row.action_href;
  if (row.dedupe_key !== null) record.dedupeKey = row.dedupe_key;
  if (row.read_at !== null) record.readAt = toIsoString(row.read_at);
  if (row.archived_at !== null) record.archivedAt = toIsoString(row.archived_at);
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
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