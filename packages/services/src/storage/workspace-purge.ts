import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getDataDirPath,
  getDaemonWorkspaceExecutionRootDir,
  getLocalDaemonStateDirPath,
  assertWorkspaceHardDeleteAllowedSync,
  hardDeleteWorkspaceSync,
  listStoredAttachmentsSync,
  type HardDeleteWorkspaceResult,
} from "@dofe-agent/db";
import { deleteWorkspaceAttachmentsSync } from "../attachments/attachments.ts";

export type PurgeWorkspaceStorageResult = {
  workspaceId: string;
  db: HardDeleteWorkspaceResult;
  removedWorkspaceDataDir: boolean;
  removedDaemonExecutionRootDir: boolean;
  removedAttachmentObjectCount: number;
};

export function purgeWorkspaceStorageSync(
  workspaceId: string,
  options?: {
    daemonStateDir?: string;
  },
): PurgeWorkspaceStorageResult {
  const workspaceDataDirPath = join(getDataDirPath(), "workspaces", workspaceId);
  const daemonExecutionRootDirPath = getDaemonWorkspaceExecutionRootDir(
    options?.daemonStateDir ?? getLocalDaemonStateDirPath(),
    workspaceId,
  );
  const removedWorkspaceDataDir = existsSync(workspaceDataDirPath);
  const removedDaemonExecutionRootDir = existsSync(daemonExecutionRootDirPath);
  const attachments = listStoredAttachmentsSync(workspaceId);

  assertWorkspaceHardDeleteAllowedSync(workspaceId);
  deleteWorkspaceAttachmentsSync(attachments);
  const db = hardDeleteWorkspaceSync(workspaceId);
  rmSync(workspaceDataDirPath, { recursive: true, force: true });
  rmSync(daemonExecutionRootDirPath, { recursive: true, force: true });

  return {
    workspaceId,
    db,
    removedWorkspaceDataDir,
    removedDaemonExecutionRootDir,
    removedAttachmentObjectCount: attachments.length,
  };
}
