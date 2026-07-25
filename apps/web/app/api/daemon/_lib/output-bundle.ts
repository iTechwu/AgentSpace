import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getWorkspaceDaemonRemoteStagingDirPath } from "@dofe-agent/db";
import type { DaemonTaskOutputBundle } from "@dofe-agent/domain";

const MAX_OUTPUT_BUNDLE_FILES = 64;
const MAX_OUTPUT_BUNDLE_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BUNDLE_TOTAL_BYTES = 25 * 1024 * 1024;
const OUTPUT_BUNDLE_ALLOWED_PREFIX = "runtime-output/";

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
    if (bundle.files.length > MAX_OUTPUT_BUNDLE_FILES) {
      throw new Error(`Output bundle has too many files; max is ${MAX_OUTPUT_BUNDLE_FILES}.`);
    }
    let totalBytes = 0;
    for (const file of bundle.files) {
      const normalizedPath = file.path.replace(/\\/g, "/").trim();
      if (!normalizedPath || normalizedPath.startsWith("/") || normalizedPath.split("/").some((segment) => segment === "..")) {
        throw new Error(`Invalid output bundle path: ${file.path}`);
      }
      if (isAbsolute(normalizedPath)) {
        throw new Error(`Output bundle path must be relative: ${file.path}`);
      }
      if (!normalizedPath.startsWith(OUTPUT_BUNDLE_ALLOWED_PREFIX)) {
        throw new Error(`Output bundle path must stay under runtime-output/: ${file.path}`);
      }

      const content = Buffer.from(file.contentBase64, "base64");
      if (content.length > MAX_OUTPUT_BUNDLE_SINGLE_FILE_BYTES) {
        throw new Error(`Output bundle file exceeds 10 MB: ${file.path}`);
      }
      totalBytes += content.length;
      if (totalBytes > MAX_OUTPUT_BUNDLE_TOTAL_BYTES) {
        throw new Error("Output bundle total size exceeds 25 MB.");
      }
      const targetPath = join(stagingDir, normalizedPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content);
    }
  } catch (error) {
    clearDaemonTaskOutputStaging(taskId, workspaceId);
    throw error;
  }

  return stagingDir;
}
