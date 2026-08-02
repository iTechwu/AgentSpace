import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getWorkspaceDaemonRemoteStagingDirPath } from "@dofe-agent/db";
import type { DaemonTaskOutputBundle } from "@dofe-agent/domain";

const MAX_OUTPUT_BUNDLE_FILES = 64;
const MAX_OUTPUT_BUNDLE_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BUNDLE_TOTAL_BYTES = 25 * 1024 * 1024;
const OUTPUT_BUNDLE_ALLOWED_PREFIX = "runtime-output/";
/** Bounded workDir subtrees captured by the daemon (see workdir-capture.ts). */
const WORKDIR_BUNDLE_ALLOWED_PREFIXES = ["repository/", "state/", "artifacts/"] as const;
/** Staging-side marker carrying the paths the provider deleted this task. */
const DELETED_PATHS_META_FILE = ".workdir-deleted.json";

export function getDaemonTaskOutputStagingDir(taskId: string, workspaceId: string): string {
  return getWorkspaceDaemonRemoteStagingDirPath(taskId, workspaceId);
}

export function hasDaemonTaskOutputStaging(taskId: string, workspaceId: string): boolean {
  return existsSync(getDaemonTaskOutputStagingDir(taskId, workspaceId));
}

export function clearDaemonTaskOutputStaging(taskId: string, workspaceId: string): void {
  rmSync(getDaemonTaskOutputStagingDir(taskId, workspaceId), { recursive: true, force: true });
}

export function materializeOutputBundleToStaging(
  taskId: string,
  workspaceId: string,
  bundle: DaemonTaskOutputBundle,
): string {
  const stagingDir = getDaemonTaskOutputStagingDir(taskId, workspaceId);
  clearDaemonTaskOutputStaging(taskId, workspaceId);

  try {
    const runtimeOutputFiles = bundle.files ?? [];
    const workspaceFiles = bundle.workspaceFiles ?? [];
    if (runtimeOutputFiles.length + workspaceFiles.length > MAX_OUTPUT_BUNDLE_FILES) {
      throw new Error(`Output bundle has too many files; max is ${MAX_OUTPUT_BUNDLE_FILES}.`);
    }
    let totalBytes = 0;
    for (const file of runtimeOutputFiles) {
      totalBytes = writeStagedFile(stagingDir, file.path, file.contentBase64, totalBytes, OUTPUT_BUNDLE_ALLOWED_PREFIX);
    }
    for (const file of workspaceFiles) {
      const allowed = WORKDIR_BUNDLE_ALLOWED_PREFIXES.some((prefix) => file.path.startsWith(prefix));
      if (!allowed) {
        throw new Error(`Workspace file must stay under repository/, state/ or artifacts/: ${file.path}`);
      }
      totalBytes = writeStagedFile(stagingDir, file.path, file.contentBase64, totalBytes, undefined, file.mode);
    }
    const deletedPaths = (bundle.deletedPaths ?? []).filter((path) => isValidWorkDirCapturePath(path));
    if (deletedPaths.length > 0) {
      writeFileSync(join(stagingDir, DELETED_PATHS_META_FILE), JSON.stringify({ deletedPaths }), "utf8");
    }
  } catch (error) {
    clearDaemonTaskOutputStaging(taskId, workspaceId);
    throw error;
  }

  return stagingDir;
}

function writeStagedFile(
  stagingDir: string,
  path: string,
  contentBase64: string,
  runningTotal: number,
  allowedPrefix?: string,
  mode?: string,
): number {
  const normalizedPath = path.replace(/\\/g, "/").trim();
  if (!normalizedPath || normalizedPath.startsWith("/") || normalizedPath.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid output bundle path: ${path}`);
  }
  if (isAbsolute(normalizedPath)) {
    throw new Error(`Output bundle path must be relative: ${path}`);
  }
  if (allowedPrefix && !normalizedPath.startsWith(allowedPrefix)) {
    throw new Error(`Output bundle path must stay under ${allowedPrefix}: ${path}`);
  }

  const content = Buffer.from(contentBase64, "base64");
  if (content.length > MAX_OUTPUT_BUNDLE_SINGLE_FILE_BYTES) {
    throw new Error(`Output bundle file exceeds 10 MB: ${path}`);
  }
  const totalBytes = runningTotal + content.length;
  if (totalBytes > MAX_OUTPUT_BUNDLE_TOTAL_BYTES) {
    throw new Error("Output bundle total size exceeds 25 MB.");
  }
  const targetPath = join(stagingDir, normalizedPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
  if (mode) {
    const parsed = Number.parseInt(mode, 8);
    if (Number.isFinite(parsed)) {
      chmodSync(targetPath, parsed);
    }
  }
  return totalBytes;
}

/**
 * Reads the staged workDir files (repository/state/artifacts) back into the
 * task-output shape the promotion path expects. Returns an empty array when the
 * daemon shipped no workDir changes.
 */
export function readStagedWorkDirFiles(taskId: string, workspaceId: string): Array<{
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
  mode?: string;
}> {
  const stagingDir = getDaemonTaskOutputStagingDir(taskId, workspaceId);
  if (!existsSync(stagingDir)) {
    return [];
  }
  const files: Array<{ path: string; bytes: Uint8Array; mediaType?: string; mode?: string }> = [];
  for (const prefix of WORKDIR_BUNDLE_ALLOWED_PREFIXES) {
    const baseDir = join(stagingDir, prefix);
    if (!existsSync(baseDir)) {
      continue;
    }
    walkStagedFiles(baseDir, (absolutePath) => {
      const stat = statSync(absolutePath);
      if (!stat.isFile()) {
        return;
      }
      const relToBase = relative(baseDir, absolutePath).replace(/\\/g, "/");
      files.push({
        path: `${prefix}${relToBase}`,
        bytes: readFileSync(absolutePath),
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
      });
    });
  }
  return files;
}

/**
 * Reads the staged tombstone list (paths the provider deleted this task). Empty
 * when the daemon shipped no deletions or the staging was cleared.
 */
export function readStagedWorkDirDeletedPaths(taskId: string, workspaceId: string): string[] {
  const stagingDir = getDaemonTaskOutputStagingDir(taskId, workspaceId);
  const metaPath = join(stagingDir, DELETED_PATHS_META_FILE);
  if (!existsSync(metaPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as { deletedPaths?: unknown };
    return Array.isArray(parsed.deletedPaths)
      ? parsed.deletedPaths.filter((path): path is string => typeof path === "string" && isValidWorkDirCapturePath(path))
      : [];
  } catch {
    return [];
  }
}

function isValidWorkDirCapturePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "..")) {
    return false;
  }
  return WORKDIR_BUNDLE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function walkStagedFiles(baseDir: string, visit: (absolutePath: string) => void): void {
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const absolutePath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      walkStagedFiles(absolutePath, visit);
    } else {
      visit(absolutePath);
    }
  }
}
