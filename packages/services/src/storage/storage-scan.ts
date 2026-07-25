import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  getDataDirPath,
  getLocalDaemonStateDirPath,
  listQueuedTasksSync,
  listStoredChannelsSync,
  listStoredEmployeesSync,
  readWorkspaceSync,
  sanitizeStoragePathSegment,
  SYSTEM_WORKSPACE_ID,
} from "@dofe-agent/db";
import { slugify } from "../shared/helpers.ts";

export type StorageScanIssueKind =
  | "orphan-workspace"
  | "orphan-channel-history"
  | "orphan-daemon-workdir"
  | "orphan-remote-staging"
  | "legacy-storage-root";

export type StorageScanIssueReason =
  | "workspace_missing"
  | "channel_missing"
  | "agent_missing"
  | "task_missing"
  | "unexpected_entry"
  | "legacy_path";

export interface StorageScanIssue {
  kind: StorageScanIssueKind;
  reason: StorageScanIssueReason;
  path: string;
  workspaceId?: string;
}

export interface StorageScanResult {
  scannedCount: number;
  issueCounts: Record<StorageScanIssueKind, number>;
  issues: StorageScanIssue[];
}

interface WorkspaceScanContext {
  workspaceId: string;
  channelSlugs: Set<string>;
  daemonChannelSlugs: Set<string>;
  daemonAgentIds: Set<string>;
  queuedTaskIds: Set<string>;
}

const EMPTY_ISSUE_COUNTS: Record<StorageScanIssueKind, number> = {
  "orphan-workspace": 0,
  "orphan-channel-history": 0,
  "orphan-daemon-workdir": 0,
  "orphan-remote-staging": 0,
  "legacy-storage-root": 0,
};

export function scanStorageArtifactsSync(): StorageScanResult {
  const issues: StorageScanIssue[] = [];
  let scannedCount = 0;
  const workspaceCache = new Map<string, WorkspaceScanContext | null>();

  const pushIssue = (issue: StorageScanIssue): void => {
    issues.push(issue);
  };

  const getWorkspaceContext = (workspaceId: string): WorkspaceScanContext | null => {
    if (workspaceCache.has(workspaceId)) {
      return workspaceCache.get(workspaceId) ?? null;
    }

    if (workspaceId !== SYSTEM_WORKSPACE_ID && readWorkspaceSync(workspaceId) === null) {
      workspaceCache.set(workspaceId, null);
      return null;
    }

    const context: WorkspaceScanContext = {
      workspaceId,
      channelSlugs: new Set(listStoredChannelsSync(workspaceId).map((channel) => slugify(channel.name))),
      daemonChannelSlugs: new Set(
        listStoredChannelsSync(workspaceId).map((channel) => sanitizeStoragePathSegment(channel.name, "channel")),
      ),
      daemonAgentIds: new Set(
        listStoredEmployeesSync(workspaceId).map((employee) => sanitizeStoragePathSegment(employee.name, "agent")),
      ),
      queuedTaskIds: new Set(listQueuedTasksSync({ workspaceId }).map((task) => sanitizeStoragePathSegment(task.id, "task"))),
    };
    workspaceCache.set(workspaceId, context);
    return context;
  };

  const workspaceRoot = join(getDataDirPath(), "workspaces");
  for (const workspaceEntry of listDirectoryEntries(workspaceRoot)) {
    scannedCount += 1;
    const workspacePath = join(workspaceRoot, workspaceEntry.name);
    if (!workspaceEntry.isDirectory()) {
      pushIssue({
        kind: "orphan-workspace",
        reason: "unexpected_entry",
        path: workspacePath,
      });
      continue;
    }

    const workspaceId = workspaceEntry.name;
    const workspaceContext = getWorkspaceContext(workspaceId);
    if (workspaceContext === null) {
      pushIssue({
        kind: "orphan-workspace",
        reason: "workspace_missing",
        path: workspacePath,
        workspaceId,
      });
      continue;
    }

    scannedCount += scanWorkspaceChannelHistory(workspaceContext, pushIssue);
    scannedCount += scanWorkspaceRemoteStaging(workspaceContext, pushIssue);
  }

  const daemonWorkspacesRoot = join(getLocalDaemonStateDirPath(), "workspaces");
  for (const workspaceEntry of listDirectoryEntries(daemonWorkspacesRoot)) {
    scannedCount += 1;
    const workspacePath = join(daemonWorkspacesRoot, workspaceEntry.name);
    if (!workspaceEntry.isDirectory()) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "unexpected_entry",
        path: workspacePath,
      });
      continue;
    }

    const workspaceId = workspaceEntry.name;
    const workspaceContext = getWorkspaceContext(workspaceId);
    if (workspaceContext === null) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "workspace_missing",
        path: workspacePath,
        workspaceId,
      });
      continue;
    }

    scannedCount += scanDaemonTaskWorkDirs(workspaceContext, join(workspacePath, "workdirs"), pushIssue);
    scannedCount += scanDaemonRemoteWorkDirs(workspaceContext, join(workspacePath, "remote-workdirs"), pushIssue);
  }

  scannedCount += scanLegacyStorageRoots(pushIssue);

  const issueCounts = { ...EMPTY_ISSUE_COUNTS };
  for (const issue of issues) {
    issueCounts[issue.kind] += 1;
  }

  issues.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return left.path.localeCompare(right.path);
  });

  return {
    scannedCount,
    issueCounts,
    issues,
  };
}

function scanLegacyStorageRoots(
  pushIssue: (issue: StorageScanIssue) => void,
): number {
  const legacyRoots = [
    join(getDataDirPath(), "attachments"),
    join(getDataDirPath(), "channel-history"),
    join(getDataDirPath(), "daemon-remote-staging"),
    join(getLocalDaemonStateDirPath(), "workdirs"),
  ];
  let scannedCount = 0;

  for (const legacyRoot of legacyRoots) {
    if (!existsSync(legacyRoot)) {
      continue;
    }
    scannedCount += 1;
    pushIssue({
      kind: "legacy-storage-root",
      reason: "legacy_path",
      path: legacyRoot,
    });
  }

  return scannedCount;
}

function scanWorkspaceChannelHistory(
  workspace: WorkspaceScanContext,
  pushIssue: (issue: StorageScanIssue) => void,
): number {
  const historyDir = join(getDataDirPath(), "workspaces", workspace.workspaceId, "channel-history");
  let scannedCount = 0;

  for (const entry of listDirectoryEntries(historyDir)) {
    scannedCount += 1;
    const entryPath = join(historyDir, entry.name);
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
      pushIssue({
        kind: "orphan-channel-history",
        reason: "unexpected_entry",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
      continue;
    }

    const channelSlug = basename(entry.name, extname(entry.name));
    if (!workspace.channelSlugs.has(channelSlug)) {
      pushIssue({
        kind: "orphan-channel-history",
        reason: "channel_missing",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
    }
  }

  return scannedCount;
}

function scanWorkspaceRemoteStaging(
  workspace: WorkspaceScanContext,
  pushIssue: (issue: StorageScanIssue) => void,
): number {
  const stagingDir = join(getDataDirPath(), "workspaces", workspace.workspaceId, "daemon-remote-staging");
  let scannedCount = 0;

  for (const entry of listDirectoryEntries(stagingDir)) {
    scannedCount += 1;
    const entryPath = join(stagingDir, entry.name);
    if (!entry.isDirectory()) {
      pushIssue({
        kind: "orphan-remote-staging",
        reason: "unexpected_entry",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
      continue;
    }

    if (!workspace.queuedTaskIds.has(entry.name)) {
      pushIssue({
        kind: "orphan-remote-staging",
        reason: "task_missing",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
    }
  }

  return scannedCount;
}

function scanDaemonTaskWorkDirs(
  workspace: WorkspaceScanContext,
  workDirsRoot: string,
  pushIssue: (issue: StorageScanIssue) => void,
): number {
  let scannedCount = 0;

  for (const entry of listDirectoryEntries(workDirsRoot)) {
    if (entry.name === "channels") {
      scannedCount += scanDaemonChannelWorkDirs(workspace, join(workDirsRoot, entry.name), pushIssue);
      continue;
    }

    scannedCount += 1;
    const entryPath = join(workDirsRoot, entry.name);
    if (!entry.isDirectory()) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "unexpected_entry",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
      continue;
    }

    if (!workspace.queuedTaskIds.has(entry.name)) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "task_missing",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
    }
  }

  return scannedCount;
}

function scanDaemonChannelWorkDirs(
  workspace: WorkspaceScanContext,
  channelsRoot: string,
  pushIssue: (issue: StorageScanIssue) => void,
): number {
  let scannedCount = 0;

  for (const threadEntry of listDirectoryEntries(channelsRoot)) {
    scannedCount += 1;
    const threadPath = join(channelsRoot, threadEntry.name);
    if (!threadEntry.isDirectory()) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "unexpected_entry",
        path: threadPath,
        workspaceId: workspace.workspaceId,
      });
      continue;
    }

    if (!workspace.daemonChannelSlugs.has(threadEntry.name)) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "channel_missing",
        path: threadPath,
        workspaceId: workspace.workspaceId,
      });
      continue;
    }

    for (const agentEntry of listDirectoryEntries(threadPath)) {
      scannedCount += 1;
      const agentPath = join(threadPath, agentEntry.name);
      if (!agentEntry.isDirectory()) {
        pushIssue({
          kind: "orphan-daemon-workdir",
          reason: "unexpected_entry",
          path: agentPath,
          workspaceId: workspace.workspaceId,
        });
        continue;
      }

      if (!workspace.daemonAgentIds.has(agentEntry.name)) {
        pushIssue({
          kind: "orphan-daemon-workdir",
          reason: "agent_missing",
          path: agentPath,
          workspaceId: workspace.workspaceId,
        });
      }
    }
  }

  return scannedCount;
}

function scanDaemonRemoteWorkDirs(
  workspace: WorkspaceScanContext,
  remoteWorkDirsRoot: string,
  pushIssue: (issue: StorageScanIssue) => void,
): number {
  let scannedCount = 0;

  for (const entry of listDirectoryEntries(remoteWorkDirsRoot)) {
    scannedCount += 1;
    const entryPath = join(remoteWorkDirsRoot, entry.name);
    if (!entry.isDirectory()) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "unexpected_entry",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
      continue;
    }

    if (!workspace.queuedTaskIds.has(entry.name)) {
      pushIssue({
        kind: "orphan-daemon-workdir",
        reason: "task_missing",
        path: entryPath,
        workspaceId: workspace.workspaceId,
      });
    }
  }

  return scannedCount;
}

function listDirectoryEntries(dirPath: string): Dirent<string>[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  return readdirSync(dirPath, { withFileTypes: true });
}

export function getStorageScanWorkspacePath(workspaceId = DEFAULT_WORKSPACE_ID): string {
  return join(getDataDirPath(), "workspaces", workspaceId);
}
