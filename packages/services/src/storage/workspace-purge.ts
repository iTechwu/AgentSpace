import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getDataDirPath,
  getDaemonWorkspaceExecutionRootDir,
  getLocalDaemonStateDirPath,
  hardDeleteWorkspaceSync,
  type HardDeleteWorkspaceResult,
} from "@dofe-agent/db";

export type PurgeWorkspaceStorageResult = {
  workspaceId: string;
  db: HardDeleteWorkspaceResult;
  removedWorkspaceDataDir: boolean;
  removedDaemonExecutionRootDir: boolean;
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

  const db = hardDeleteWorkspaceSync(workspaceId);
  rmSync(workspaceDataDirPath, { recursive: true, force: true });
  rmSync(daemonExecutionRootDirPath, { recursive: true, force: true });

  return {
    workspaceId,
    db,
    removedWorkspaceDataDir,
    removedDaemonExecutionRootDir,
  };
}
