// 3.5-4：自 provider-runtime.ts 拆出——可执行文件发现/版本探测与路径、
// shell、去重等基础工具，供 catalog/工具能力/env 等模块复用。
import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import { platform } from "node:process";

export function detectProviderVersion(executablePath: string, versionArgs: string[][] = [["--version"]]): string {
  for (const args of versionArgs) {
    const result = spawnSync(executablePath, args, {
      env: process.env,
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      continue;
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const firstLine = output.split(/\r?\n/)[0] ?? "";
    if (firstLine) {
      return firstLine;
    }
  }
  return "";
}

export function findExecutableOnPath(command: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  const extensions = platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""];
  for (const baseDir of pathValue.split(delimiter)) {
    for (const ext of extensions) {
      const candidate = join(baseDir, command + ext);
      if (isExecutableCandidate(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function isExecutableCandidate(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findFirstExecutableOnPath(commands: string[]): string | null {
  for (const command of commands) {
    const executablePath = findExecutableOnPath(command);
    if (executablePath) {
      return executablePath;
    }
  }
  return null;
}

export function resolveProviderCommands(candidate: { command?: string; commands?: string[] }): string[] {
  return candidate.commands?.length ? candidate.commands : candidate.command ? [candidate.command] : [];
}

function isRootUser(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

let didWarnClaudeRootRuntime = false;

export function warnClaudeRootRuntimeIfNeeded(action: "detected" | "executing"): void {
  if (!isRootUser() || didWarnClaudeRootRuntime) {
    return;
  }
  didWarnClaudeRootRuntime = true;
  console.warn(
    `Claude Code runtime ${action} while dofe-agent-daemon is running as root. `
    + "Ensure /root is logged in to Claude Code and treat task commands as root-privileged.",
  );
}

export function isPathLike(value: string): boolean {
  return isAbsolute(value) || value.includes("/") || value.includes("\\");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
