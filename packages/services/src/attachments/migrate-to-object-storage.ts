import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { AgentSpaceState, MessageAttachment, WorkspaceMessage } from "@agent-space/domain/workspace";
import { getDatabase, withTransaction } from "@agent-space/db";
import {
  createAttachmentStorageClient,
  type StoredAttachmentObject,
} from "./storage.ts";

interface WorkspaceSnapshotRow {
  id: string;
  stateJson: AgentSpaceState | string;
  stateVersion: number;
}

interface MigrationResult {
  workspaceCount: number;
  scannedAttachments: number;
  migratedAttachments: number;
  alreadyCloudAttachments: number;
  missingLocalFiles: Array<{
    workspaceId: string;
    attachmentId: string;
    storedPath: string;
  }>;
}

export function migrateLocalAttachmentsToObjectStorageSync(input?: {
  dryRun?: boolean;
}): MigrationResult {
  const dryRun = input?.dryRun === true;
  const db = getDatabase();
  const storage = createAttachmentStorageClient();
  const result: MigrationResult = {
    workspaceCount: 0,
    scannedAttachments: 0,
    migratedAttachments: 0,
    alreadyCloudAttachments: 0,
    missingLocalFiles: [],
  };

  const work = () => {
    const snapshots = db.prepare(
      "SELECT id, state_json, state_version FROM workspace_snapshot ORDER BY id ASC",
    ).all() as unknown as WorkspaceSnapshotRow[];
    result.workspaceCount = snapshots.length;

    for (const row of snapshots) {
      const state = typeof row.stateJson === "string"
        ? JSON.parse(row.stateJson) as AgentSpaceState
        : row.stateJson;
      let changed = false;
      for (const message of state.messages ?? []) {
        const migrated = migrateMessageAttachments({
          workspaceId: row.id,
          message,
          dryRun,
          storage,
          result,
        });
        changed = changed || migrated;
      }

      if (changed && !dryRun) {
        db.prepare(
          `UPDATE workspace_snapshot
           SET state_json = ?,
               state_version = state_version + 1,
               updated_at = ?
           WHERE id = ?`,
        ).run(JSON.stringify(state), new Date().toISOString(), row.id);
        updateAttachmentRows(db, row.id, state);
      }
    }
  };

  if (dryRun) {
    work();
  } else {
    withTransaction(db, work);
  }
  return result;
}

function migrateMessageAttachments(input: {
  workspaceId: string;
  message: WorkspaceMessage;
  dryRun: boolean;
  storage: ReturnType<typeof createAttachmentStorageClient>;
  result: MigrationResult;
}): boolean {
  let changed = false;
  for (const attachment of input.message.attachments ?? []) {
    input.result.scannedAttachments += 1;
    if ((attachment.storageProvider === "tos" || attachment.storageProvider === "s3") && attachment.storageKey) {
      input.result.alreadyCloudAttachments += 1;
      continue;
    }
    if (!existsSync(attachment.storedPath)) {
      input.result.missingLocalFiles.push({
        workspaceId: input.workspaceId,
        attachmentId: attachment.id,
        storedPath: attachment.storedPath,
      });
      continue;
    }
    if (!statSync(attachment.storedPath).isFile()) {
      input.result.missingLocalFiles.push({
        workspaceId: input.workspaceId,
        attachmentId: attachment.id,
        storedPath: attachment.storedPath,
      });
      continue;
    }

    if (!input.dryRun) {
      const stored = input.storage.putObjectSync({
        workspaceId: input.workspaceId,
        attachmentId: attachment.id,
        fileName: basename(attachment.fileName.replace(/\\/g, "/")) || attachment.fileName,
        contentBytes: readFileSync(attachment.storedPath),
        localPath: attachment.storedPath,
        mediaType: attachment.mediaType,
      });
      applyStoredObject(attachment, stored);
      changed = true;
    }
    input.result.migratedAttachments += 1;
  }
  return changed;
}

function updateAttachmentRows(db: ReturnType<typeof getDatabase>, workspaceId: string, state: AgentSpaceState): void {
  for (const message of state.messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      db.prepare(
        `UPDATE attachment
         SET stored_path = ?,
             storage_provider = ?,
             storage_bucket = ?,
             storage_region = ?,
             storage_endpoint = ?,
             storage_key = ?,
             storage_url = ?,
             sha256 = ?
         WHERE workspace_id = ? AND id = ?`,
      ).run(
        attachment.storedPath,
        attachment.storageProvider ?? "local",
        attachment.storageBucket ?? null,
        attachment.storageRegion ?? null,
        attachment.storageEndpoint ?? null,
        attachment.storageKey ?? null,
        attachment.storageUrl ?? null,
        attachment.sha256 ?? null,
        workspaceId,
        attachment.id,
      );
    }
  }
}

function applyStoredObject(attachment: MessageAttachment, stored: StoredAttachmentObject): void {
  attachment.storageProvider = stored.provider;
  attachment.storageBucket = stored.bucket;
  attachment.storageRegion = stored.region;
  attachment.storageEndpoint = stored.endpoint;
  attachment.storageKey = stored.key;
  attachment.storageUrl = stored.url;
  attachment.sha256 = stored.sha256;
  attachment.storedPath = stored.storedPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = migrateLocalAttachmentsToObjectStorageSync({ dryRun });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
