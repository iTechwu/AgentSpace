// @deprecated — Phase 2 pg 直连原型，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 attachments-prisma.ts（同等接口）。

import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import type { StoredAttachmentRecord } from "../attachments.ts";

export async function listStoredAttachmentsAsync(
  workspaceId: string,
): Promise<StoredAttachmentRecord[]> {
  const sql = `SELECT id, workspace_id, message_id, channel_name, speaker, role,
                     file_name, media_type, size_bytes, content_digest, stored_path,
                     storage_provider, storage_bucket, storage_region,
                     storage_endpoint, storage_key, storage_url, note,
                     upload_id, source_message_index, source_message_time,
                     source_summary, deleted_at, deleted_by_user_id,
                     deleted_by_display_name, created_at, updated_at
              FROM attachment
              WHERE workspace_id = $1
              ORDER BY source_message_index ASC, created_at ASC, id ASC`;

  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  try {
    await client.connect();
    const result = await client.query<RawRow>(sql, [workspaceId]);
    return result.rows.map(mapRow);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function isAttachmentsAsyncReadEnabled(): boolean {
  return process.env.ATTACHMENTS_ASYNC_READ_ENABLED === "1";
}

export function isAttachmentsShadowReadEnabled(): boolean {
  return process.env.ATTACHMENTS_SHADOW_READ_ENABLED === "1";
}

interface RawRow {
  id: string;
  workspace_id: string;
  message_id: string | null;
  channel_name: string | null;
  speaker: string;
  role: string;
  file_name: string;
  media_type: string | null;
  size_bytes: number | null;
  content_digest: string | null;
  stored_path: string;
  storage_provider: string | null;
  storage_bucket: string | null;
  storage_region: string | null;
  storage_endpoint: string | null;
  storage_key: string | null;
  storage_url: string | null;
  note: string | null;
  upload_id: string | null;
  source_message_index: number;
  source_message_time: Date | string | null;
  source_summary: string | null;
  deleted_at: Date | string | null;
  deleted_by_user_id: string | null;
  deleted_by_display_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapRow(row: RawRow): StoredAttachmentRecord {
  const record: StoredAttachmentRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    fileName: row.file_name,
    mediaType: row.media_type ?? "application/octet-stream",
    sizeBytes: row.size_bytes ?? 0,
    kind: "file",
    storedPath: row.stored_path,
    speaker: row.speaker,
    role: row.role,
    sourceMessageIndex: row.source_message_index,
    createdAt: toIsoString(row.created_at),
  };
  if (row.message_id !== null) record.messageId = row.message_id;
  if (row.channel_name !== null) record.channelName = row.channel_name;
  if (row.content_digest !== null) record.sha256 = row.content_digest;
  if (row.storage_provider !== null) {
    const provider = row.storage_provider;
    if (provider === "tos" || provider === "local") {
      record.storageProvider = provider;
    }
  }
  if (row.storage_bucket !== null) record.storageBucket = row.storage_bucket;
  if (row.storage_region !== null) record.storageRegion = row.storage_region;
  if (row.storage_endpoint !== null) record.storageEndpoint = row.storage_endpoint;
  if (row.storage_key !== null) record.storageKey = row.storage_key;
  if (row.storage_url !== null) record.storageUrl = row.storage_url;
  if (row.source_message_time !== null) record.sourceMessageTime = toIsoString(row.source_message_time);
  if (row.source_summary !== null) record.sourceSummary = row.source_summary;
  if (row.deleted_at !== null) record.deletedAt = toIsoString(row.deleted_at);
  if (row.deleted_by_user_id !== null) record.deletedByUserId = row.deleted_by_user_id;
  if (row.deleted_by_display_name !== null) record.deletedByDisplayName = row.deleted_by_display_name;
  return record;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}