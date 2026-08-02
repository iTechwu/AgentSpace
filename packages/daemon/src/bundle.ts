import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DaemonInputBundleFile, DaemonTaskInputBundle, DaemonTaskOutputBundle } from "./daemon-api.ts";
import { getRuntimeOutputDir } from "./runtime-output.ts";
import { collectRuntimeOutputBundleFiles } from "./runtime-output-manifests.ts";
import {
  collectWorkDirBlobChanges,
  collectWorkDirChanges,
  type WorkDirBlobUploadEntry,
  type WorkDirFileEntry,
} from "./workdir-capture.ts";

export function clearTaskOutputArtifacts(workDir: string): void {
  rmSync(join(workDir, "last-message.txt"), { force: true });
  rmSync(getRuntimeOutputDir(workDir), { recursive: true, force: true });
}

export const INPUT_BUNDLE_MAX_FILES = 1_000;
export const INPUT_BUNDLE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const INPUT_BUNDLE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_MANIFEST_MAX_FILES = 100_000;
export const WORKSPACE_MANIFEST_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const WORKSPACE_MANIFEST_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

export class InputBundleValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "InputBundleValidationError";
    this.code = code;
  }
}

export function createDaemonBundleFile(path: string, bytes: Uint8Array, mode?: string): DaemonInputBundleFile {
  return {
    path,
    contentBase64: Buffer.from(bytes).toString("base64"),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(mode ? { mode } : {}),
  };
}

export function assertDaemonInputBundleBudget(files: DaemonInputBundleFile[]): void {
  if (files.length > INPUT_BUNDLE_MAX_FILES) {
    throw new InputBundleValidationError(
      "input_bundle.file_count_exceeded",
      `Input bundle has ${files.length} files; limit is ${INPUT_BUNDLE_MAX_FILES}.`,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > INPUT_BUNDLE_MAX_FILE_BYTES) {
      throw new InputBundleValidationError(
        "input_bundle.file_size_exceeded",
        `Input file "${file.path}" has invalid size ${file.size}; per-file limit is ${INPUT_BUNDLE_MAX_FILE_BYTES}.`,
      );
    }
    totalBytes += file.size;
    if (totalBytes > INPUT_BUNDLE_MAX_TOTAL_BYTES) {
      throw new InputBundleValidationError(
        "input_bundle.total_size_exceeded",
        `Input bundle exceeds the ${INPUT_BUNDLE_MAX_TOTAL_BYTES} byte total limit.`,
      );
    }
  }
}

export function materializeInputBundle(workDir: string, bundle: DaemonTaskInputBundle): void {
  assertDaemonInputBundleBudget(bundle.files);
  const prepared: Array<{ file: DaemonInputBundleFile; targetPath: string; bytes: Buffer }> = [];
  const paths = new Set<string>();
  for (const file of bundle.files) {
    const targetPath = resolveBundleTargetPath(workDir, file.path);
    const normalizedPath = relative(workDir, targetPath).replace(/\\/g, "/");
    if (paths.has(normalizedPath)) {
      throw new InputBundleValidationError("input_bundle.duplicate_path", `Duplicate bundle path: ${file.path}`);
    }
    paths.add(normalizedPath);
    const bytes = decodeBundleFile(file);
    prepared.push({ file, targetPath, bytes });
  }
  for (const { file, targetPath, bytes } of prepared) {
    assertNoSymlinkPath(workDir, targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    assertNoSymlinkPath(workDir, targetPath);
    writeFileSync(targetPath, bytes);
    if (file.mode && /^[0-7]{3,4}$/.test(file.mode)) {
      // Restore the executable bit the control plane preserved, so scripts that
      // passed install remain runnable in the task workDir.
      chmodSync(targetPath, parseInt(file.mode, 8));
    }
  }
}

/**
 * Materializes a remote task bundle with a persistent content-addressed cache.
 * Every referenced blob is downloaded and verified before the workDir changes,
 * so a missing/tampered cache miss cannot produce a partial workspace.
 */
export async function materializeRemoteInputBundle(input: {
  workDir: string;
  stateDir: string;
  bundle: DaemonTaskInputBundle;
  fetchWorkspaceBlob: (taskId: string, revisionId: string, sha256: string) => Promise<Uint8Array>;
}): Promise<{ downloadedBlobs: number; reusedBlobs: number }> {
  const workspace = input.bundle.workspace;
  if (!workspace) {
    materializeInputBundle(input.workDir, input.bundle);
    return { downloadedBlobs: 0, reusedBlobs: 0 };
  }
  assertWorkspaceManifestBudget(workspace.files);
  const cacheRoot = resolve(input.stateDir, "workspace-blob-cache");
  mkdirSync(cacheRoot, { recursive: true });
  const cachePaths = new Map<string, string>();
  let downloadedBlobs = 0;
  let reusedBlobs = 0;

  for (const file of workspace.files) {
    resolveBundleTargetPath(input.workDir, file.path);
    const cachePath = resolve(cacheRoot, file.sha256.slice(0, 2), file.sha256);
    if (isVerifiedBlobFile(cachePath, file.sha256, file.size)) {
      reusedBlobs += 1;
      cachePaths.set(file.sha256, cachePath);
      continue;
    }
    if (existsSync(cachePath)) rmSync(cachePath, { force: true });
    const bytes = Buffer.from(await input.fetchWorkspaceBlob(input.bundle.taskId, workspace.revisionId, file.sha256));
    assertBlobBytes(file.path, file.sha256, file.size, bytes);
    mkdirSync(dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      try {
        renameSync(temporaryPath, cachePath);
      } catch {
        if (!isVerifiedBlobFile(cachePath, file.sha256, file.size)) throw new Error("workspace.cache_publish_failed");
      }
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    downloadedBlobs += 1;
    cachePaths.set(file.sha256, cachePath);
  }

  for (const file of workspace.files) {
    const targetPath = resolveBundleTargetPath(input.workDir, file.path);
    assertNoSymlinkPath(input.workDir, targetPath);
    if (existsSync(targetPath)) {
      const stat = lstatSync(targetPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new InputBundleValidationError(
          "workspace.target_unsafe",
          `Workspace target is not a regular file: ${file.path}`,
        );
      }
      if (!isVerifiedBlobFile(targetPath, file.sha256, file.size)) {
        throw new InputBundleValidationError(
          "workspace.target_mismatch",
          `Existing workspace target does not match revision ${workspace.revisionId}: ${file.path}`,
        );
      }
      if (file.mode && /^[0-7]{3,4}$/.test(file.mode)) chmodSync(targetPath, parseInt(file.mode, 8));
      continue;
    }
    const cachePath = cachePaths.get(file.sha256);
    if (!cachePath) throw new Error(`workspace.cache_missing: ${file.sha256}`);
    mkdirSync(dirname(targetPath), { recursive: true });
    assertNoSymlinkPath(input.workDir, targetPath);
    writeFileSync(targetPath, readFileSync(cachePath), { flag: "wx", mode: 0o600 });
    if (file.mode && /^[0-7]{3,4}$/.test(file.mode)) chmodSync(targetPath, parseInt(file.mode, 8));
  }
  // Per-task files intentionally overlay the durable workspace head.
  materializeInputBundle(input.workDir, input.bundle);
  return { downloadedBlobs, reusedBlobs };
}

function assertWorkspaceManifestBudget(files: NonNullable<DaemonTaskInputBundle["workspace"]>["files"]): void {
  if (files.length > WORKSPACE_MANIFEST_MAX_FILES) {
    throw new InputBundleValidationError("workspace.file_count_exceeded", `Workspace has ${files.length} files.`);
  }
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (paths.has(file.path)) throw new InputBundleValidationError("workspace.duplicate_path", file.path);
    paths.add(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > WORKSPACE_MANIFEST_MAX_FILE_BYTES) {
      throw new InputBundleValidationError("workspace.file_invalid", `Invalid workspace file: ${file.path}`);
    }
    total += file.size;
    if (total > WORKSPACE_MANIFEST_MAX_TOTAL_BYTES) {
      throw new InputBundleValidationError("workspace.total_size_exceeded", "Workspace exceeds the 20 GiB materialization limit.");
    }
  }
}

function isVerifiedBlobFile(path: string, sha256: string, size: number): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== size) return false;
    return createHash("sha256").update(readFileSync(path)).digest("hex") === sha256;
  } catch {
    return false;
  }
}

function assertBlobBytes(path: string, sha256: string, size: number, bytes: Uint8Array): void {
  if (bytes.byteLength !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new InputBundleValidationError("workspace.blob_mismatch", `Workspace blob failed verification: ${path}`);
  }
}

function decodeBundleFile(file: DaemonInputBundleFile): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
    throw new InputBundleValidationError("input_bundle.base64_invalid", `Input file "${file.path}" is not canonical base64.`);
  }
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.byteLength !== file.size) {
    throw new InputBundleValidationError(
      "input_bundle.size_mismatch",
      `Input file "${file.path}" size mismatch: expected ${file.size}, got ${bytes.byteLength}.`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || digest !== file.sha256) {
    throw new InputBundleValidationError(
      "input_bundle.digest_mismatch",
      `Input file "${file.path}" digest mismatch.`,
    );
  }
  return bytes;
}

function assertNoSymlinkPath(workDir: string, targetPath: string): void {
  let current = targetPath;
  while (current !== workDir) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new InputBundleValidationError(
        "input_bundle.symlink_target_forbidden",
        `Input file target traverses a symbolic link: ${relative(workDir, current)}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function collectRuntimeOutputBundle(
  workDir: string,
  headManifest?: { files?: WorkDirFileEntry[] },
): DaemonTaskOutputBundle | undefined {
  const runtimeOutputDir = getRuntimeOutputDir(workDir);
  const files = existsSync(runtimeOutputDir) ? collectRuntimeOutputBundleFiles(workDir) : [];

  const capture = collectWorkDirChanges(workDir, headManifest);
  if (capture.unsafePaths.length > 0) {
    throw new Error(
      `workdir_capture_unsafe: refused ${capture.unsafePaths.length} unsafe path(s): ${capture.unsafePaths.slice(0, 3).join(", ")}`,
    );
  }
  if (capture.truncated) {
    // Fail closed: never ship a partial workspace snapshot. Until chunked upload
    // exists, any truncation aborts the commit with an explicit limit error
    // instead of silently dropping files and publishing an incomplete revision.
    throw new Error("output_limit_exceeded: workDir capture exceeded its file/size budget and was truncated");
  }
  const workspaceFiles = capture.files.map((file) => ({
    path: file.path,
    contentBase64: Buffer.from(file.bytes).toString("base64"),
    mode: file.mode,
  }));

  if (files.length === 0 && workspaceFiles.length === 0 && capture.deletedPaths.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    format: "json-inline-v1",
    files,
    ...(workspaceFiles.length > 0 ? { workspaceFiles } : {}),
    ...(capture.deletedPaths.length > 0 ? { deletedPaths: capture.deletedPaths } : {}),
  };
}

export function prepareRemoteOutputBundle(
  workDir: string,
  headManifest?: { files?: WorkDirFileEntry[] },
): { bundle?: DaemonTaskOutputBundle; uploads: WorkDirBlobUploadEntry[] } {
  const runtimeOutputDir = getRuntimeOutputDir(workDir);
  const files = existsSync(runtimeOutputDir) ? collectRuntimeOutputBundleFiles(workDir) : [];
  const capture = collectWorkDirBlobChanges(workDir, headManifest);
  if (capture.unsafePaths.length > 0) {
    throw new Error(
      `workdir_capture_unsafe: refused ${capture.unsafePaths.length} unsafe path(s): ${capture.unsafePaths.slice(0, 3).join(", ")}`,
    );
  }
  if (files.length === 0 && capture.files.length === 0 && capture.deletedPaths.length === 0) {
    return { uploads: [] };
  }
  return {
    bundle: {
      version: 1,
      format: "json-inline-v1",
      files,
      ...(capture.files.length > 0 ? {
        workspaceBlobFiles: capture.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          size: file.size,
          mode: file.mode,
        })),
      } : {}),
      ...(capture.deletedPaths.length > 0 ? { deletedPaths: capture.deletedPaths } : {}),
    },
    uploads: capture.files,
  };
}

export function readWorkspaceBlobUploadBytes(file: WorkDirBlobUploadEntry): Uint8Array {
  const fd = openSync(file.absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.size) {
      throw new Error(`workspace_upload_source_changed: ${file.path}`);
    }
    const bytes = readFileSync(fd);
    assertBlobBytes(file.path, file.sha256, file.size, bytes);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function sanitizePathSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "task";
}

function resolveBundleTargetPath(workDir: string, bundlePath: string): string {
  const candidatePath = bundlePath.trim();
  if (!candidatePath) {
    throw new Error("Bundle file path is required.");
  }
  if (isAbsolute(candidatePath)) {
    throw new Error(`Bundle file path must be relative: ${candidatePath}`);
  }

  const resolvedPath = resolve(workDir, candidatePath);
  const relativePath = relative(workDir, resolvedPath);
  if (
    relativePath === "" ||
    relativePath === "." ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  ) {
    return resolvedPath;
  }

  throw new Error(`Bundle file path escapes workDir: ${candidatePath}`);
}
