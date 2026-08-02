import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_TASK_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_LOG_LINES = 50;
export const DEFAULT_STATE_DIR_NAME = ".dofe-agent-daemon";

export function resolveDefaultDaemonStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.DOFE_AGENT_DAEMON_STATE_DIR?.trim();
  if (configured) {
    return resolve(configured);
  }

  const homeDir = environment.HOME?.trim() || homedir();
  return resolve(homeDir, DEFAULT_STATE_DIR_NAME);
}

export function ensureDaemonStateDir(stateDir: string): string {
  const resolvedStateDir = resolve(stateDir);
  if (!existsSync(resolvedStateDir)) {
    mkdirSync(resolvedStateDir, { recursive: true });
  }
  return resolvedStateDir;
}

export function openDaemonLogFile(logPath: string): number {
  return openSync(logPath, "a");
}

export function getDaemonPidFilePath(stateDir: string): string {
  return join(ensureDaemonStateDir(stateDir), "daemon.pid");
}

export function getDaemonLogFilePath(stateDir: string): string {
  return join(ensureDaemonStateDir(stateDir), "daemon.log");
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
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function readLastLines(filePath: string, lines: number): string[] {
  const content = readFileSync(filePath, "utf8");
  const chunks = content.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  return chunks.slice(-lines);
}

export function renderDaemonSummary(summary: object): string {
  return Object.entries(summary)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

export function getStandaloneCliEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return join(dirname(currentFile), currentFile.endsWith(".ts") ? "cli.ts" : "cli.js");
}

export function resolveLogFileSize(logPath: string): number {
  return statSync(logPath).size;
}
