import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readHeadRevisionSync } from "@dofe-agent/db";
import { createAttachmentStorageClient, type WorkspaceRevisionManifest } from "@dofe-agent/services";

/**
 * Bounded capture of an employee's real working-directory changes. The daemon
 * seeds task workDirs with input bundles, skills and knowledge; the provider
 * creates `repository/`, `state/` and `artifacts/` inside them. At completion
 * we diff those three subtrees against the head-revision manifest and ship the
 * changed files through the output bundle so the control plane promotes them
 * into the persistent workspace. Rebuilt/transient subtrees (`.codex/skills`,
 * `.agent_context/`, `runtime-output/`, caches, gateway logs) are excluded by
 * construction — we only ever walk the include list.
 */

export const WORKDIR_CAPTURE_INCLUDE_DIRS = ["repository", "state", "artifacts", "checkpoints"] as const;

export const WORKDIR_CAPTURE_MAX_FILES = 64;
export const WORKDIR_CAPTURE_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
export const WORKDIR_CAPTURE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface CapturedWorkDirFile {
  /** Relative path under the workDir, e.g. `repository/src/a.ts`. */
  path: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
  /** Octal permission string, e.g. "0755" / "0644". */
  mode: string;
}

export interface WorkDirCaptureResult {
  files: CapturedWorkDirFile[];
  /** Files whose sha256 matched the head manifest and were not re-shipped. */
  skippedUnchanged: number;
  /** True when the file/total budget was exceeded and some files were dropped. */
  truncated: boolean;
  /** Unsafe entries that made a complete snapshot impossible. */
  unsafePaths: string[];
  /**
   * Captured paths present in the head manifest that no longer exist under the
   * workDir. The provider deleted them, so the promoted revision must drop them
   * (a tombstone), otherwise stale files survive in head and get restored by a
   * later task.
   */
  deletedPaths: string[];
}

export interface WorkDirFileEntry {
  path: string;
  sha256: string;
}

/** Reads the head revision's manifest for a task's employee (undefined when none). */
export function readEmployeeHeadManifestSync(
  workspaceId: string,
  employeeName: string,
): { files?: WorkDirFileEntry[] } | undefined {
  const head = readHeadRevisionSync(employeeName, workspaceId);
  if (!head) {
    return undefined;
  }
  try {
    return JSON.parse(head.manifestJson) as { files?: WorkDirFileEntry[] };
  } catch {
    return undefined;
  }
}

/**
 * Walks the bounded capture subtrees under `workDir`, computes per-file sha256,
 * and drops files whose digest already exists in `headManifest`. The returned
 * bytes are the transport form (callers base64-encode for the bundle, or pass
 * bytes straight to promotion).
 */
export function collectWorkDirChanges(
  workDir: string,
  headManifest?: { files?: WorkDirFileEntry[] },
): WorkDirCaptureResult {
  const headDigestByPath = new Map<string, string>();
  for (const file of headManifest?.files ?? []) {
    headDigestByPath.set(file.path, file.sha256.toLowerCase());
  }

  const files: CapturedWorkDirFile[] = [];
  let skippedUnchanged = 0;
  let truncated = false;
  let totalBytes = 0;
  const deletedPaths: string[] = [];
  const unsafePaths: string[] = [];
  for (const file of headManifest?.files ?? []) {
    if (!isCapturedIncludePath(file.path)) {
      continue;
    }
    const candidate = join(workDir, file.path);
    try {
      const st = lstatSync(candidate);
      // A file replaced by a symlink is not a regular capture (see walker); the
      // head entry is gone, so treat it as deleted.
      if (!st.isFile()) {
        deletedPaths.push(file.path);
      }
    } catch {
      deletedPaths.push(file.path);
    }
  }

  for (const includeDir of WORKDIR_CAPTURE_INCLUDE_DIRS) {
    if (files.length >= WORKDIR_CAPTURE_MAX_FILES) {
      truncated = true;
      break;
    }
    const baseDir = join(workDir, includeDir);
    // The include ROOT itself must be a real directory, never a symlink: a
    // provider could point `repository/` at an external directory and every
    // inner-entry check would be bypassed. lstat (no follow) + realpath
    // containment against the normalized workDir.
    try {
      const rootStat = lstatSync(baseDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        unsafePaths.push(`${includeDir}/`);
        continue;
      }
      assertRealPathInside(baseDir, workDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      unsafePaths.push(`${includeDir}/`);
      continue;
    }

    walkCaptureFiles(baseDir, (absolutePath) => {
      if (files.length >= WORKDIR_CAPTURE_MAX_FILES) {
        truncated = true;
        return;
      }
      // lstat (not stat): a symlink is never a regular file, so a provider
      // cannot smuggle files that live outside the task workDir into the
      // persistent workspace by pointing a symlink at them.
      const stat = lstatSync(absolutePath);
      if (!stat.isFile() || stat.nlink !== 1) {
        unsafePaths.push(relative(workDir, absolutePath).replace(/\\/g, "/"));
        return;
      }
      if (stat.size > WORKDIR_CAPTURE_MAX_SINGLE_FILE_BYTES) {
        // Drop the oversized file but keep collecting files that fit; the
        // `truncated` flag is a signal, not a short-circuit.
        truncated = true;
        return;
      }

      const relToBase = relative(baseDir, absolutePath).replace(/\\/g, "/");
      const relPath = `${includeDir}/${relToBase}`;
      // O_NOFOLLOW closes the TOCTOU window where a file is swapped for a
      // symlink between the lstat and the read (Linux/macOS).
      let bytes: Uint8Array;
      try {
        bytes = readFileBytesNoFollow(absolutePath);
      } catch {
        unsafePaths.push(relative(workDir, absolutePath).replace(/\\/g, "/"));
        return;
      }
      const sha256 = sha256Hex(bytes);

      const headDigest = headDigestByPath.get(relPath);
      if (headDigest && headDigest === sha256) {
        skippedUnchanged += 1;
        return;
      }
      if (totalBytes + bytes.byteLength > WORKDIR_CAPTURE_MAX_TOTAL_BYTES) {
        truncated = true;
        return;
      }

      totalBytes += bytes.byteLength;
      const mode = statSync(absolutePath).mode & 0o777;
      files.push({
        path: relPath,
        bytes,
        sha256,
        size: bytes.byteLength,
        mode: mode.toString(8).padStart(4, "0"),
      });
    }, (absolutePath) => {
      unsafePaths.push(relative(workDir, absolutePath).replace(/\\/g, "/"));
    });
  }

  return { files, skippedUnchanged, truncated, unsafePaths: [...new Set(unsafePaths)], deletedPaths };
}

function isCapturedIncludePath(path: string): boolean {
  return WORKDIR_CAPTURE_INCLUDE_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** Shared head-manifest parser used by the regular and strict restore paths. */
function parseHeadRevisionManifest(manifestJson: string): WorkspaceRevisionManifest | null {
  try {
    const parsed = JSON.parse(manifestJson) as WorkspaceRevisionManifest;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Materializes the head revision's files into a task workDir. Used at task
 * start so a fresh runtime is seeded with the durable workspace before the
 * input bundle overlays per-task data. Skips paths that already exist so a
 * persistent conversation workDir is never clobbered by an older snapshot.
 *
 * Restoration is symlink-safe: every parent directory is created/verified with
 * lstat (never following an existing symlink), and files are written with
 * O_EXCL|O_NOFOLLOW. Missing blobs are COUNTED, never silently swallowed — the
 * caller decides whether a partial workspace is a blocker or a degraded state.
 */
export function materializeHeadRevisionToWorkDir(
  workDir: string,
  input: { workspaceId: string; employeeName: string },
): { materializedFiles: number; missingBlobs: number } {
  const head = readHeadRevisionSync(input.employeeName, input.workspaceId);
  if (!head) {
    return { materializedFiles: 0, missingBlobs: 0 };
  }
  const manifest = parseHeadRevisionManifest(head.manifestJson);
  if (!manifest) {
    // An invalid manifest is NOT a silent 0/0 success: the whole head is
    // unreadable, which must surface as a degraded workspace (>=1 missing blob).
    return { materializedFiles: 0, missingBlobs: 1 };
  }

  const storage = createAttachmentStorageClient();
  let materializedFiles = 0;
  let missingBlobs = 0;
  for (const file of manifest.files ?? []) {
    const targetPath = resolveCapturedPath(workDir, file.path);
    let bytes: Uint8Array;
    try {
      bytes = storage.getContentAddressedBlobSync({
        workspaceId: input.workspaceId,
        sha256: file.sha256,
      });
    } catch {
      missingBlobs += 1;
      continue;
    }
    // Same content verification as the strict mount path: a tampered blob must
    // never be restored as if it were the durable revision.
    if (sha256Hex(bytes) !== file.sha256.toLowerCase()) {
      missingBlobs += 1;
      continue;
    }
    if (existsSync(targetPath)) {
      try {
        const stat = lstatSync(targetPath);
        // A regular divergent file can be an intentional, not-yet-committed
        // conversation edit. Durable storage was already read and verified
        // above, so preserve the local edit and let the next diff commit it.
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          missingBlobs += 1;
        }
      } catch {
        missingBlobs += 1;
      }
      continue;
    }
    try {
      mkdirParentsNoFollow(dirname(targetPath), workDir);
      writeFileNoFollow(targetPath, bytes);
      applyCapturedMode(targetPath, file.mode);
      materializedFiles += 1;
    } catch {
      // A parent directory became a symlink or the file cannot be created
      // safely — count it as not restored rather than writing outside the workDir.
      missingBlobs += 1;
    }
  }
  return { materializedFiles, missingBlobs };
}

/**
 * FAIL-CLOSED materialization used by the recovery workspace-mount worker.
 * Throws on any divergence from the durable head revision: missing head, a
 * pinned headRevisionId mismatch, an unparseable manifest, a blob that cannot
 * be read, a per-file digest mismatch, or a final materialized-count that does
 * not equal the manifest file count. A mount must never report success for a
 * partial or tampered workspace.
 */
export function materializeHeadRevisionToWorkDirStrict(
  workDir: string,
  input: { workspaceId: string; employeeName: string; expectedHeadRevisionId?: string },
): { materializedFiles: number; expectedFiles: number } {
  assertSafeWorkspaceRoot(workDir);
  const head = readHeadRevisionSync(input.employeeName, input.workspaceId);
  if (!head) {
    throw new Error("Workspace mount failed: employee has no head revision to materialize.");
  }
  if (input.expectedHeadRevisionId && head.id !== input.expectedHeadRevisionId) {
    throw new Error(
      `Workspace mount failed: head revision ${head.id.slice(0, 12)}… differs from the pinned ${input.expectedHeadRevisionId.slice(0, 12)}….`,
    );
  }
  const manifest = parseHeadRevisionManifest(head.manifestJson);
  if (!manifest) {
    throw new Error("Workspace mount failed: head revision manifest is invalid.");
  }

  const storage = createAttachmentStorageClient();
  const expectedFiles = (manifest.files ?? []).length;
  let materializedFiles = 0;
  for (const file of manifest.files ?? []) {
    const targetPath = resolveCapturedPath(workDir, file.path);
    let bytes: Uint8Array;
    try {
      bytes = storage.getContentAddressedBlobSync({
        workspaceId: input.workspaceId,
        sha256: file.sha256,
      });
    } catch {
      throw new Error(`Workspace mount failed: blob ${file.sha256.slice(0, 12)}… for "${file.path}" is unreadable.`);
    }
    if (sha256Hex(bytes) !== file.sha256.toLowerCase()) {
      throw new Error(`Workspace mount failed: blob digest mismatch for "${file.path}".`);
    }
    try {
      mkdirParentsNoFollow(dirname(targetPath), workDir);
      if (existsSync(targetPath)) {
        const stat = lstatSync(targetPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error("existing target is not a regular file");
        }
        const existingBytes = readFileBytesNoFollow(targetPath);
        if (sha256Hex(existingBytes) !== file.sha256.toLowerCase()) {
          throw new Error("existing target digest differs from the durable revision");
        }
      } else {
        writeFileNoFollow(targetPath, bytes);
      }
      applyCapturedMode(targetPath, file.mode);
      materializedFiles += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Workspace mount failed: could not safely materialize "${file.path}": ${detail}.`);
    }
  }
  if (materializedFiles !== expectedFiles) {
    throw new Error(
      `Workspace mount failed: materialized ${materializedFiles}/${expectedFiles} files.`,
    );
  }
  pruneUndeclaredEntries(workDir, new Set((manifest.files ?? []).map((file) => file.path)));
  return { materializedFiles, expectedFiles };
}

/** Removes stale files from an earlier persistent mount without following symlinks. */
function pruneUndeclaredEntries(rootDir: string, declaredPaths: Set<string>): void {
  const visit = (directory: string): void => {
    const openedDirectory = readDirectoryIdentity(directory);
    for (const entryName of readdirSync(directory)) {
      assertDirectoryIdentity(directory, openedDirectory);
      const absolutePath = join(directory, entryName);
      const relPath = relative(rootDir, absolutePath).replace(/\\/g, "/");
      const entry = lstatSync(absolutePath);
      if (entry.isSymbolicLink()) {
        rmSync(absolutePath, { force: true });
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        assertDirectoryIdentity(directory, openedDirectory);
        const required = [...declaredPaths].some((path) => path.startsWith(`${relPath}/`));
        if (!required) {
          // rmdir never follows a swapped symlink. If a concurrent writer added
          // content, fail closed instead of recursively deleting through a path
          // whose directory identity may have changed.
          rmdirSync(absolutePath);
        }
        continue;
      }
      if (!entry.isFile() || !declaredPaths.has(relPath)) {
        rmSync(absolutePath, { force: true });
      }
    }
    assertDirectoryIdentity(directory, openedDirectory);
  };
  assertSafeWorkspaceRoot(rootDir);
  visit(rootDir);
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function readDirectoryIdentity(directory: string): DirectoryIdentity {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workspace directory is no longer a real directory: ${directory}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): void {
  const current = readDirectoryIdentity(directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Workspace directory changed while materializing: ${directory}`);
  }
}

function assertSafeWorkspaceRoot(rootDir: string): void {
  const root = lstatSync(rootDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`Workspace root must be a real directory: ${rootDir}`);
  }
}

/** Creates/verifies every parent directory under root without following symlinks. */
function mkdirParentsNoFollow(targetDir: string, rootDir: string): void {
  assertSafeWorkspaceRoot(rootDir);
  const rel = relative(rootDir, targetDir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Restore path escapes workDir: ${targetDir}`);
  }
  let current = rootDir;
  for (const segment of rel.split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    try {
      const st = lstatSync(current);
      if (!st.isDirectory()) {
        throw new Error(`Restore path component is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        mkdirSync(current);
      } else {
        throw error;
      }
    }
  }
}

/** Writes a fresh file with O_EXCL (never overwrite) + O_NOFOLLOW (no symlink swap). */
function writeFileNoFollow(targetPath: string, bytes: Uint8Array): void {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(targetPath, flags, 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Applies a captured octal mode (e.g. "0755") to a restored file, when present. */
function applyCapturedMode(targetPath: string, mode?: string): void {
  if (!mode) return;
  const parsed = Number.parseInt(mode, 8);
  if (!Number.isFinite(parsed)) return;
  const fd = openSync(targetPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Restore target is not a single-link regular file: ${targetPath}`);
    }
    fchmodSync(fd, parsed & 0o777);
  } finally {
    closeSync(fd);
  }
}

function walkCaptureFiles(
  baseDir: string,
  visit: (absolutePath: string) => void,
  onUnsafe: (absolutePath: string) => void,
): void {
  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // Refuse to follow symlinks at any depth (file or directory): the Provider
      // must never ship credentials, daemon state or other readable files into
      // the persistent workspace by symlinking them under repository/state/…
      onUnsafe(join(baseDir, entry.name));
      continue;
    }
    const absolutePath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      // Verify the real directory still lives inside the subtree we are walking
      // (guards against a parent directory being replaced by a symlink).
      assertRealPathInside(absolutePath, baseDir);
      walkCaptureFiles(absolutePath, visit, onUnsafe);
    } else {
      visit(absolutePath);
    }
  }
}

function assertRealPathInside(absolutePath: string, baseDir: string): void {
  let real: string;
  try {
    real = realpathSync(absolutePath);
  } catch (error) {
    throw error;
  }
  const rel = relative(realpathSync(baseDir), real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`WorkDir capture path escapes its subtree: ${absolutePath}`);
  }
}

/** Reads a regular file with O_NOFOLLOW so a swap to a symlink fails loudly. */
function readFileBytesNoFollow(absolutePath: string): Uint8Array {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(absolutePath, flags);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function resolveCapturedPath(workDir: string, capturedPath: string): string {
  const candidatePath = capturedPath.trim();
  if (!candidatePath) {
    throw new Error("Captured path is required.");
  }
  if (isAbsolute(candidatePath)) {
    throw new Error(`Captured path must be relative: ${candidatePath}`);
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
  throw new Error(`Captured path escapes workDir: ${candidatePath}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
