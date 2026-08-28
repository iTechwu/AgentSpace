// daemon CLI 的pid/进程/日志文件管理（从 commands/daemon.ts 拆出，3.6 巨型文件项）。

import { getLocalDaemonStateDirPath } from "@dofe-agent/db";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function ensureDaemonStateDir(): string {
  return getLocalDaemonStateDirPath();
}
export function getDaemonPidFilePath(): string {
  return join(ensureDaemonStateDir(), "daemon.pid");
}
export function getDaemonLogFilePath(): string {
  return join(ensureDaemonStateDir(), "daemon.log");
}
export function readPidIfRunning(pidPath: string): number | null {
  if (!existsSync(pidPath)) {
    return null;
  }

  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return isProcessRunning(pid) ? pid : null;
}
export function cleanupStalePidFile(pidPath: string): void {
  if (!existsSync(pidPath)) {
    return;
  }
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
    rmSync(pidPath, { force: true });
  }
}
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function readLastLines(filePath: string, lines: number): string[] {
  const content = readFileSync(filePath, "utf8");
  const chunks = content.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  return chunks.slice(-lines);
}
export function renderDaemonSummary(summary: Record<string, string | number | boolean>): string {
  return Object.entries(summary)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}
export function resolveCliEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return join(dirname(currentFile), "..", "index.ts");
}
export function resolveRepositoryRoot(): string {
  let currentDir = process.cwd();

  while (true) {
    if (existsSync(join(currentDir, "Target.md"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return process.cwd();
    }

    currentDir = parentDir;
  }
}
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
