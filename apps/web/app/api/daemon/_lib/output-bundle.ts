import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { getWorkspaceDaemonRemoteStagingDirPath } from "@dofe-agent/db";
import type { DaemonTaskOutputBundle } from "@dofe-agent/domain";
import { createAttachmentStorageClient } from "@dofe-agent/services";
import { WORKDIR_CAPTURE_INCLUDE_DIRS } from "dofe-agent-daemon";

const MAX_OUTPUT_BUNDLE_FILES = 64;
const MAX_OUTPUT_BUNDLE_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BUNDLE_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_WORKSPACE_BLOB_FILES = 100_000;
const MAX_WORKSPACE_BLOB_SINGLE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_WORKSPACE_BLOB_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const OUTPUT_BUNDLE_ALLOWED_PREFIX = "runtime-output/";
/**
 * Bounded workDir subtrees captured by the daemon — SINGLE source of truth,
 * derived from the daemon's own capture list so a new capture dir (e.g.
 * `checkpoints/`) can never silently break the staging/promotion path.
 */
const WORKDIR_BUNDLE_ALLOWED_PREFIXES = WORKDIR_CAPTURE_INCLUDE_DIRS.map((dir) => `${dir}/`);
/** Staging-side marker carrying the paths the provider deleted this task. */
const DELETED_PATHS_META_FILE = ".workdir-deleted.json";
const COMPLETION_EFFECTS_META_FILE = ".completion-effects.json";

export function getDaemonTaskOutputStagingDir(taskId: string, workspaceId: string): string {
  return getWorkspaceDaemonRemoteStagingDirPath(taskId, workspaceId);
}

export function hasDaemonTaskOutputStaging(taskId: string, workspaceId: string): boolean {
  return existsSync(getDaemonTaskOutputStagingDir(taskId, workspaceId));
}

export function clearDaemonTaskOutputStaging(taskId: string, workspaceId: string): void {
  rmSync(getDaemonTaskOutputStagingDir(taskId, workspaceId), { recursive: true, force: true });
}

export function readTaskCompletionEffectsSnapshot<T>(taskId: string, workspaceId: string): T | null {
  const path = join(getDaemonTaskOutputStagingDir(taskId, workspaceId), COMPLETION_EFFECTS_META_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeTaskCompletionEffectsSnapshot<T>(taskId: string, workspaceId: string, value: T): void {
  const stagingDir = getDaemonTaskOutputStagingDir(taskId, workspaceId);
  mkdirSync(stagingDir, { recursive: true });
  const path = join(stagingDir, COMPLETION_EFFECTS_META_FILE);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function materializeOutputBundleToStaging(
  taskId: string,
  workspaceId: string,
  bundle: DaemonTaskOutputBundle,
): string {
  const stagingDir = getDaemonTaskOutputStagingDir(taskId, workspaceId);
  const completionSnapshot = readTaskCompletionEffectsSnapshot<unknown>(taskId, workspaceId);
  if (completionSnapshot !== null) {
    // Once effects are checkpointed, this exact staging tree is the commit
    // candidate. A retry may re-send the request body, but it must never mix a
    // new bundle with the already-applied effects snapshot.
    return stagingDir;
  }
  clearDaemonTaskOutputStaging(taskId, workspaceId);

  try {
    const runtimeOutputFiles = bundle.files ?? [];
    const workspaceFiles = bundle.workspaceFiles ?? [];
    const workspaceBlobFiles = bundle.workspaceBlobFiles ?? [];
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
    if (workspaceBlobFiles.length > MAX_WORKSPACE_BLOB_FILES) {
      throw new Error(`Workspace output has too many changed files; max is ${MAX_WORKSPACE_BLOB_FILES}.`);
    }
    const storage = createAttachmentStorageClient();
    let workspaceBlobTotal = 0;
    const seenBlobPaths = new Set<string>();
    for (const file of workspaceBlobFiles) {
      const normalizedPath = file.path.replace(/\\/g, "/").trim();
      if (normalizedPath !== file.path) {
        throw new Error(`Workspace output path is not canonical: ${file.path}`);
      }
      if (seenBlobPaths.has(normalizedPath) || workspaceFiles.some((inline) => inline.path === normalizedPath)) {
        throw new Error(`Duplicate workspace output path: ${file.path}`);
      }
      seenBlobPaths.add(normalizedPath);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WORKSPACE_BLOB_SINGLE_FILE_BYTES) {
        throw new Error(`Workspace output file has invalid size: ${file.path}`);
      }
      workspaceBlobTotal += file.size;
      if (workspaceBlobTotal > MAX_WORKSPACE_BLOB_TOTAL_BYTES) {
        throw new Error("Workspace output exceeds the 20 GiB total limit.");
      }
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Workspace output file has invalid digest: ${file.path}`);
      }
      const bytes = storage.getContentAddressedBlobSync({ workspaceId, sha256: file.sha256 });
      if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error(`Workspace output blob failed verification: ${file.path}`);
      }
      writeStagedBytes(stagingDir, file.path, bytes, file.mode);
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

function writeStagedBytes(stagingDir: string, path: string, content: Uint8Array, mode?: string): void {
  const normalizedPath = path.replace(/\\/g, "/").trim();
  if (
    !normalizedPath || normalizedPath.startsWith("/") || isAbsolute(normalizedPath)
    || normalizedPath.split("/").some((segment) => segment === "..")
    || !WORKDIR_BUNDLE_ALLOWED_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))
  ) {
    throw new Error(`Invalid workspace output path: ${path}`);
  }
  const targetPath = join(stagingDir, normalizedPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
  if (mode && /^[0-7]{3,4}$/.test(mode)) chmodSync(targetPath, Number.parseInt(mode, 8));
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
import { createHash } from "node:crypto";
