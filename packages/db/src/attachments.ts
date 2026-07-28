import type { DofeAgentState, MessageAttachment, WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "./database.ts";

export interface StoredAttachmentRecord extends MessageAttachment {
  workspaceId: string;
  messageId?: string;
  channelName?: string;
  speaker: string;
  role: string;
  sourceMessageTime?: string;
  sourceMessageIndex: number;
  sourceSummary?: string;
  createdAt: string;
}

export function replaceStoredAttachmentsSync(
  state: Pick<DofeAgentState, "messages"> & Partial<Pick<DofeAgentState, "materials">>,
  workspaceId = DEFAULT_WORKSPACE_ID,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("DELETE FROM attachment WHERE workspace_id = ?").run(workspaceId);
    for (const [messageIndex, message] of state.messages.entries()) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.deletedAt) {
          continue;
        }
        insertStoredAttachmentSync({
          workspaceId,
          message,
          attachment,
          messageIndex,
          fallbackCreatedAt: now,
        });
      }
    }
    for (const [materialIndex, material] of (state.materials ?? []).entries()) {
      if (
        material.kind !== "file"
        || !material.id
        || !material.fileName
        || !material.storedPath
        || !material.storageKey
      ) {
        continue;
      }
      insertStoredAttachmentSync({
        workspaceId,
        message: {
          id: `material-${material.id}`,
          speaker: "system",
          role: "agent",
          time: now,
          summary: material.source,
        },
        attachment: {
          id: material.id,
          fileName: material.fileName,
          mediaType: material.mediaType ?? "application/octet-stream",
          sizeBytes: material.sizeBytes ?? 0,
          kind: "file",
          storedPath: material.storedPath,
          storageProvider: "tos",
          storageBucket: material.storageBucket,
          storageRegion: material.storageRegion,
          storageEndpoint: material.storageEndpoint,
          storageKey: material.storageKey,
          storageUrl: material.storageUrl,
          sha256: material.sha256,
        },
        messageIndex: state.messages.length + materialIndex,
        fallbackCreatedAt: now,
      });
    }
  });
}

export function readStoredAttachmentSync(
  workspaceId: string,
  attachmentId: string,
): StoredAttachmentRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT *
     FROM attachment
     WHERE workspace_id = ? AND id = ?
     LIMIT 1`,
  ).get(workspaceId, attachmentId);
  return row ? mapStoredAttachment(row) : null;
}

export function listStoredAttachmentsSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredAttachmentRecord[] {
  return getDatabase()
    .prepare(
      `SELECT *
       FROM attachment
       WHERE workspace_id = ?
       ORDER BY source_message_index ASC, created_at ASC, id ASC`,
    )
    .all(workspaceId)
    .map((row) => mapStoredAttachment(row))
    .filter((row): row is StoredAttachmentRecord => row !== null);
}

function insertStoredAttachmentSync(input: {
  workspaceId: string;
  message: WorkspaceMessage;
  attachment: MessageAttachment;
  messageIndex: number;
  fallbackCreatedAt: string;
}): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO attachment (
      workspace_id,
      id,
      message_id,
      channel_name,
      speaker,
      role,
      file_name,
      media_type,
      kind,
      size_bytes,
      stored_path,
      storage_provider,
      storage_bucket,
      storage_region,
      storage_endpoint,
      storage_key,
      storage_url,
      sha256,
      source_message_time,
      source_message_index,
      source_summary,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      message_id = EXCLUDED.message_id,
      channel_name = EXCLUDED.channel_name,
      speaker = EXCLUDED.speaker,
      role = EXCLUDED.role,
      file_name = EXCLUDED.file_name,
      media_type = EXCLUDED.media_type,
      kind = EXCLUDED.kind,
      size_bytes = EXCLUDED.size_bytes,
      stored_path = EXCLUDED.stored_path,
      storage_provider = EXCLUDED.storage_provider,
      storage_bucket = EXCLUDED.storage_bucket,
      storage_region = EXCLUDED.storage_region,
      storage_endpoint = EXCLUDED.storage_endpoint,
      storage_key = EXCLUDED.storage_key,
      storage_url = EXCLUDED.storage_url,
      sha256 = EXCLUDED.sha256,
      source_message_time = EXCLUDED.source_message_time,
      source_message_index = EXCLUDED.source_message_index,
      source_summary = EXCLUDED.source_summary`,
  ).run(
    input.workspaceId,
    input.attachment.id,
    input.message.id,
    input.message.channel ?? null,
    input.message.speaker,
    input.message.role,
    input.attachment.fileName,
    input.attachment.mediaType,
    input.attachment.kind,
    input.attachment.sizeBytes,
    input.attachment.storedPath,
    input.attachment.storageProvider ?? "tos",
    input.attachment.storageBucket ?? null,
    input.attachment.storageRegion ?? null,
    input.attachment.storageEndpoint ?? null,
    input.attachment.storageKey ?? null,
    input.attachment.storageUrl ?? null,
    input.attachment.sha256 ?? null,
    input.message.time,
    input.messageIndex,
    input.message.summary,
    input.fallbackCreatedAt,
  );
}

function mapStoredAttachment(row: Record<string, unknown>): StoredAttachmentRecord | null {
  if (
    typeof row.workspaceId !== "string" ||
    typeof row.id !== "string" ||
    typeof row.fileName !== "string" ||
    typeof row.mediaType !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.sizeBytes !== "number" ||
    typeof row.storedPath !== "string"
  ) {
    return null;
  }

  return {
    workspaceId: row.workspaceId,
    id: row.id,
    messageId: typeof row.messageId === "string" ? row.messageId : undefined,
    channelName: typeof row.channelName === "string" ? row.channelName : undefined,
    speaker: typeof row.speaker === "string" ? row.speaker : "",
    role: typeof row.role === "string" ? row.role : "",
    fileName: row.fileName,
    mediaType: row.mediaType,
    kind: row.kind === "image" ? "image" : "file",
    sizeBytes: row.sizeBytes,
    storedPath: row.storedPath,
    storageProvider: "tos",
    storageBucket: typeof row.storageBucket === "string" ? row.storageBucket : undefined,
    storageRegion: typeof row.storageRegion === "string" ? row.storageRegion : undefined,
    storageEndpoint: typeof row.storageEndpoint === "string" ? row.storageEndpoint : undefined,
    storageKey: typeof row.storageKey === "string" ? row.storageKey : undefined,
    storageUrl: typeof row.storageUrl === "string" ? row.storageUrl : undefined,
    sha256: typeof row.sha256 === "string" ? row.sha256 : undefined,
    sourceMessageTime: typeof row.sourceMessageTime === "string" ? row.sourceMessageTime : undefined,
    sourceMessageIndex: typeof row.sourceMessageIndex === "number" ? row.sourceMessageIndex : 0,
    sourceSummary: typeof row.sourceSummary === "string" ? row.sourceSummary : undefined,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}
