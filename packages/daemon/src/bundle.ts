import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DaemonTaskInputBundle, DaemonTaskOutputBundle } from "./daemon-api.ts";
import { getRuntimeOutputDir } from "./runtime-output.ts";
import { collectRuntimeOutputBundleFiles } from "./runtime-output-manifests.ts";
import { collectWorkDirChanges, type WorkDirFileEntry } from "./workdir-capture.ts";

export function clearTaskOutputArtifacts(workDir: string): void {
  rmSync(join(workDir, "last-message.txt"), { force: true });
  rmSync(getRuntimeOutputDir(workDir), { recursive: true, force: true });
}

export function materializeInputBundle(workDir: string, bundle: DaemonTaskInputBundle): void {
  for (const file of bundle.files) {
    const targetPath = resolveBundleTargetPath(workDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, Buffer.from(file.contentBase64, "base64"));
    if (file.mode && /^[0-7]{3,4}$/.test(file.mode)) {
      // Restore the executable bit the control plane preserved, so scripts that
      // passed install remain runnable in the task workDir.
      chmodSync(targetPath, parseInt(file.mode, 8));
    }
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
