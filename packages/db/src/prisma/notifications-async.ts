// notifications Phase 2 异步 primary（pg.Client 直连原型）：
// - listWorkspaceNotificationsAsync 通过 pg.Client 直连 PG 拉
//   workspace_notification 行，作为 cutover runner 的 async primary。
// - shadow 关闭时无任何额外开销（不在 sync 路径上调用）。
// - asyncToNotificationRecord 桥接 pg JSONB → object 与 Date → ISO 的类型差异。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { ListWorkspaceNotificationsOptions, WorkspaceNotificationRecord } from "../notifications.ts";

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

const RECIPIENT_TYPES = new Set(["human", "employee"]);
const ACTOR_TYPES = new Set(["human", "agent", "system"]);
const RESOURCE_TYPES = new Set([
  "approval",
  "channel",
  "channel_member",
  "channel_document",
  "channel_invitation",
  "channel_access_request",
  "credential",
  "deployment",
  "document",
  "employee",
  "knowledge",
  "message",
  "milestone",
  "model",
  "runtime",
  "runtime_credential",
  "task",
  "workspace",
]);
const SEVERITIES = new Set(["info", "warning", "error", "success"]);
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
  const limit = normalizeLimit(options.limit);
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
      .map((row) => mapNotificationRow(row))
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

function normalizeStatusFilter(status: ListWorkspaceNotificationsOptions["status"]): string[] {
  if (!status) return [];
  if (Array.isArray(status)) return status.filter((s) => STATUSES.has(s));
  if (STATUSES.has(status)) return [status];
  return [];
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 500);
}

function mapNotificationRow(row: AsyncNotificationRow): WorkspaceNotificationRecord | null {
  if (!RECIPIENT_TYPES.has(row.recipient_type)) return null;
  if (!RESOURCE_TYPES.has(row.resource_type)) return null;
  if (!SEVERITIES.has(row.severity)) return null;
  if (!STATUSES.has(row.status)) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    recipientType: row.recipient_type as WorkspaceNotificationRecord["recipientType"],
    recipientId: row.recipient_id,
    actorType: row.actor_type && ACTOR_TYPES.has(row.actor_type)
      ? (row.actor_type as WorkspaceNotificationRecord["actorType"])
      : undefined,
    actorId: row.actor_id ?? undefined,
    type: row.type,
    resourceType: row.resource_type as WorkspaceNotificationRecord["resourceType"],
    resourceId: row.resource_id ?? undefined,
    channelName: row.channel_name ?? undefined,
    title: row.title,
    body: row.body,
    actionHref: row.action_href ?? undefined,
    severity: row.severity as WorkspaceNotificationRecord["severity"],
    status: row.status as WorkspaceNotificationRecord["status"],
    dedupeKey: row.dedupe_key ?? undefined,
    metadataJson: normalizeMetadataJson(row.metadata_json),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    readAt: row.read_at instanceof Date
      ? row.read_at.toISOString()
      : row.read_at ?? undefined,
    archivedAt: row.archived_at instanceof Date
      ? row.archived_at.toISOString()
      : row.archived_at ?? undefined,
  };
}

function normalizeMetadataJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}