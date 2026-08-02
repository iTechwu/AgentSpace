import { readWorkspaceAttachmentBytesSync, reconcileStaleCommitJournalsSync } from "@dofe-agent/services";
import type { QueuedTaskRecord } from "@dofe-agent/db";
import { loadTaskOutputEnvelope } from "dofe-agent-daemon";
import {
  getDaemonTaskOutputStagingDir,
  readStagedWorkDirDeletedPaths,
  readStagedWorkDirFiles,
} from "./output-bundle";
import { existsSync } from "node:fs";

/**
 * Derives a task's durable outputs from the daemon output staging dir, for the
 * commit-reconciliation worker. Mirrors the promotion inputs the complete route
 * builds (staged workDir files + tombstones + the runtime-output envelope's
 * attachments, re-read from the persisted attachment store). Returns null when
 * the staging is gone or unreadable — the reconciliation treats that as
 * unrecoverable.
 */
function deriveStagedTaskOutputsForReconciliation(task: QueuedTaskRecord): {
  outputs: Array<{ path: string; bytes: Uint8Array; mediaType?: string; mode?: string }>;
  deletedPaths: string[];
} | null {
  const stagingDir = getDaemonTaskOutputStagingDir(task.id, task.workspaceId);
  if (!existsSync(stagingDir)) {
    return null;
  }
  try {
    const envelope = loadTaskOutputEnvelope(stagingDir, "", task.workspaceId);
    return {
      outputs: [
        ...readStagedWorkDirFiles(task.id, task.workspaceId),
        ...envelope.attachments.map((attachment) => ({
          path: attachment.fileName,
          bytes: readWorkspaceAttachmentBytesSync(attachment),
          mediaType: attachment.mediaType,
        })),
      ],
      deletedPaths: readStagedWorkDirDeletedPaths(task.id, task.workspaceId),
    };
  } catch {
    return null;
  }
}

/** Maintenance-cron stage: re-drives stale preparing_commit journals. */
export function runCommitReconciliationStage(): {
  committed: number;
  retried: number;
  rolledBack: number;
  skipped: number;
} {
  return reconcileStaleCommitJournalsSync({
    staleBeforeSeconds: 3600,
    maxAttempts: 3,
    deriveOutputs: deriveStagedTaskOutputsForReconciliation,
  });
}
