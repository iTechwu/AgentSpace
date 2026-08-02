import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

export const WORKDIR_CAPTURE_INCLUDE_DIRS = ["repository", "state", "artifacts"] as const;

export const WORKDIR_CAPTURE_MAX_FILES = 64;
export const WORKDIR_CAPTURE_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
export const WORKDIR_CAPTURE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface CapturedWorkDirFile {
  /** Relative path under the workDir, e.g. `repository/src/a.ts`. */
  path: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
}

export interface WorkDirCaptureResult {
  files: CapturedWorkDirFile[];
  /** Files whose sha256 matched the head manifest and were not re-shipped. */
  skippedUnchanged: number;
  /** True when the file/total budget was exceeded and some files were dropped. */
  truncated: boolean;
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

  for (const includeDir of WORKDIR_CAPTURE_INCLUDE_DIRS) {
    if (files.length >= WORKDIR_CAPTURE_MAX_FILES) {
      truncated = true;
      break;
    }
    const baseDir = join(workDir, includeDir);
    if (!existsSync(baseDir)) {
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
      if (!stat.isFile()) {
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
        return; // entry vanished or became a symlink mid-walk; skip it
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
      files.push({ path: relPath, bytes, sha256, size: bytes.byteLength });
    });
  }

  return { files, skippedUnchanged, truncated };
}

/**
 * Materializes the head revision's files into a task workDir. Used at task
 * start so a fresh runtime is seeded with the durable workspace before the
 * input bundle overlays per-task data. Skips paths that already exist so a
 * persistent conversation workDir is never clobbered by an older snapshot.
 */
export function materializeHeadRevisionToWorkDir(
  workDir: string,
  input: { workspaceId: string; employeeName: string },
): { materializedFiles: number } {
  const head = readHeadRevisionSync(input.employeeName, input.workspaceId);
  if (!head) {
    return { materializedFiles: 0 };
  }
  let manifest: WorkspaceRevisionManifest;
  try {
    manifest = JSON.parse(head.manifestJson) as WorkspaceRevisionManifest;
  } catch {
    return { materializedFiles: 0 };
  }

  const storage = createAttachmentStorageClient();
  let materializedFiles = 0;
  for (const file of manifest.files ?? []) {
    const targetPath = resolveCapturedPath(workDir, file.path);
    if (existsSync(targetPath)) {
      continue;
    }
    try {
      const bytes = storage.getContentAddressedBlobSync({
        workspaceId: input.workspaceId,
        sha256: file.sha256,
      });
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes);
      materializedFiles += 1;
    } catch {
      // A missing blob is non-fatal here; health-check / recovery catch it.
    }
  }
  return { materializedFiles };
}

function walkCaptureFiles(baseDir: string, visit: (absolutePath: string) => void): void {
  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // Refuse to follow symlinks at any depth (file or directory): the Provider
      // must never ship credentials, daemon state or other readable files into
      // the persistent workspace by symlinking them under repository/state/…
      continue;
    }
    const absolutePath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      // Verify the real directory still lives inside the subtree we are walking
      // (guards against a parent directory being replaced by a symlink).
      assertRealPathInside(absolutePath, baseDir);
      walkCaptureFiles(absolutePath, visit);
    } else {
      visit(absolutePath);
    }
  }
}

function assertRealPathInside(absolutePath: string, baseDir: string): void {
  let real: string;
  try {
    real = realpathSync(absolutePath);
  } catch {
    return; // broken entry; the caller's lstat will drop it
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
