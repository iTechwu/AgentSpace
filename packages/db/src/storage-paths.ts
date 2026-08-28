import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_WORKSPACE_ID, getWorkspaceDataDirPath, resolveRepositoryRoot } from "./database.ts";

export const SYSTEM_WORKSPACE_ID = "__system__";

const LOCAL_DAEMON_STATE_DIR = join("data", "daemon");

// Persistent, user-visible workspace assets stay under data/workspaces/{workspaceId}/...
export function getSystemWorkspaceDataDirPath(): string {
  return getWorkspaceDataDirPath(SYSTEM_WORKSPACE_ID);
}

export function getWorkspaceChannelHistoryDirPath(workspaceId = DEFAULT_WORKSPACE_ID): string {
  return ensureDirectory(join(getWorkspaceDataDirPath(workspaceId), "channel-history"));
}

export function getWorkspaceDaemonRemoteStagingDirPath(
  taskId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): string {
  return join(
    getWorkspaceDataDirPath(workspaceId),
    "daemon-remote-staging",
    sanitizeStoragePathSegment(taskId, "task"),
  );
}

export function getLocalDaemonStateDirPath(): string {
  return ensureDirectory(join(resolveRepositoryRoot(), LOCAL_DAEMON_STATE_DIR));
}

// Execution-state workdirs stay under a daemon-owned state root, not workspace assets.
export function getDaemonWorkspaceExecutionRootDir(
  stateDir: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): string {
  return join(resolve(stateDir), "workspaces", sanitizeStoragePathSegment(workspaceId, DEFAULT_WORKSPACE_ID));
}

export function getDaemonTaskWorkDirPath(
  stateDir: string,
  input: {
    taskId: string;
    workspaceId?: string;
  },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "workdirs",
    sanitizeStoragePathSegment(input.taskId, "task"),
  );
}

export function getDaemonChannelWorkDirPath(
  stateDir: string,
  input: {
    threadId: string;
    agentId: string;
    workspaceId?: string;
  },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "workdirs",
    "channels",
    sanitizeStoragePathSegment(input.threadId, "channel"),
    sanitizeStoragePathSegment(input.agentId, "agent"),
  );
}

export function getDaemonRemoteTaskWorkDirPath(
  stateDir: string,
  input: {
    taskId: string;
    workspaceId?: string;
  },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "remote-workdirs",
    sanitizeStoragePathSegment(input.taskId, "task"),
  );
}

export function getDaemonSkillInstallWorkDirPath(
  stateDir: string,
  input: {
    workspaceId?: string;
    installationId: string;
    operationId: string;
  },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "skill-install",
    sanitizeStoragePathSegment(input.installationId, "installation"),
    sanitizeStoragePathSegment(input.operationId, "operation"),
  );
}

/**
 * Root of the digest-keyed Runtime skill cache. A cache entry survives across
 * operations so a re-install of the same artifact digest reuses materialized
 * files instead of re-downloading them.
 */
export function getDaemonSkillInstallCacheRoot(stateDir: string, input: { workspaceId?: string }): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "skill-install-cache",
  );
}

export function getDaemonSkillInstallCachePath(
  stateDir: string,
  input: { workspaceId?: string; artifactDigest: string },
): string {
  return join(
    getDaemonSkillInstallCacheRoot(stateDir, input),
    sanitizeStoragePathSegment(input.artifactDigest.toLowerCase(), "digest"),
  );
}

/**
 * Per-installation isolated dependency environment directory. Dependencies are
 * installed HERE (never --global/--user / Provider HOME), wiped at the start of
 * each prepare so no stale version survives a re-install.
 */
export function getDaemonSkillInstallEnvsDirPath(
  stateDir: string,
  input: { workspaceId?: string; installationId: string },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "skill-install-envs",
    sanitizeStoragePathSegment(input.installationId, "installation"),
  );
}

/**
 * Root of the runtime app dependency installs (GitHub skill dependencies). The
 * daemon executor runs install plans with cwd = this root so the plan's relative
 * `deps/<manager>` dirs land here, isolated from Provider HOME/global paths.
 */
export function getDaemonRuntimeAppDepsRootPath(
  stateDir: string,
  input: { workspaceId?: string },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "runtime-app-deps",
  );
}

/**
 * PERSISTENT runtime workspace dir: the head revision materialized here by the
 * mount worker is KEPT (D-07/D-08: the runtime's durable workspace, seeded from
 * the control plane). Future tasks materialize on top of it; the dir survives
 * the mount operation's lifetime.
 */
export function getDaemonRuntimeWorkspaceDirPath(
  stateDir: string,
  input: { workspaceId?: string; runtimeId: string; employeeName: string },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "runtime-workspaces",
    sanitizeStoragePathSegment(input.runtimeId, "runtime"),
    sanitizeStoragePathSegment(input.employeeName, "employee"),
  );
}

/** Transient verification dir a daemon uses to prove it can materialize a workspace. */
export function getDaemonWorkspaceMountWorkDirPath(
  stateDir: string,
  input: { workspaceId?: string; operationId: string },
): string {
  return join(
    getDaemonWorkspaceExecutionRootDir(stateDir, input.workspaceId ?? DEFAULT_WORKSPACE_ID),
    "workspace-mount",
    sanitizeStoragePathSegment(input.operationId, "operation"),
  );
}

export function sanitizeStoragePathSegment(value: string, fallback = "item"): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function ensureDirectory(dirPath: string): string {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}
