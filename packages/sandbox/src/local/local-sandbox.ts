import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:process";
import type { ChildProcess } from "node:child_process";
import type { Sandbox } from "../interface.ts";
import type { ExecCommand, ExecResult, FileEntry, SandboxStatus } from "../types.ts";

const KILL_GRACE_PERIOD_MS = 5_000;

export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly status: SandboxStatus = "active";

  private readonly workDir: string;
  private readonly activeChildren = new Set<ChildProcess>();

  constructor(workDir: string, runtimeId: string) {
    this.workDir = resolve(workDir);
    this.id = runtimeId;
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.resolveInsideSandbox(path), "utf8");
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const absolutePath = this.resolveInsideSandbox(path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  async readDir(path: string): Promise<FileEntry[]> {
    const absolutePath = this.resolveInsideSandbox(path);
    const entries = await readdir(absolutePath, { withFileTypes: true });

    return Promise.all(entries.map(async (entry) => {
      const entryPath = join(absolutePath, entry.name);
      const stats = await lstat(entryPath);
      return {
        name: entry.name,
        path: relative(this.workDir, entryPath) || ".",
        isDirectory: entry.isDirectory(),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      } satisfies FileEntry;
    }));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.resolveInsideSandbox(path));
      return true;
    } catch {
      return false;
    }
  }

  async exec(command: ExecCommand): Promise<ExecResult> {
    const startedAt = Date.now();
    const resolved = resolveSpawnCommand(command.command);
    const args = [...resolved.prependArgs, ...(command.args ?? [])];
    const child = spawn(resolved.command, args, {
      cwd: this.resolveCommandCwd(command.cwd),
      env: { ...process.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.activeChildren.add(child);
    child.stdin.on("error", () => {
      // The process may exit before it consumes stdin; stdout/stderr still
      // carry the actionable failure details.
    });
    const stdinController = {
      writeStdin: (data: string): void => {
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(data);
        }
      },
      closeStdin: (): void => {
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.end();
        }
      },
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;

    return await new Promise<ExecResult>((resolvePromise, rejectPromise) => {
      child.stdout.on("data", (chunk) => {
        const value = String(chunk);
        stdout += value;
        command.onStdout?.(value);
      });

      child.stderr.on("data", (chunk) => {
        const value = String(chunk);
        stderr += value;
        command.onStderr?.(value);
      });

      command.onReady?.(stdinController);
      if (command.keepStdinOpen) {
        if (command.input) {
          stdinController.writeStdin(command.input);
        }
      } else {
        child.stdin.end(command.input ?? "");
      }

      if (command.timeoutMs && command.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, KILL_GRACE_PERIOD_MS);
        }, command.timeoutMs);
      }

      child.on("error", (error) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        this.activeChildren.delete(child);
        rejectPromise(error);
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        this.activeChildren.delete(child);
        resolvePromise({
          stdout,
          stderr,
          exitCode,
          signal: signal ?? undefined,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
    });
  }

  async snapshot(): Promise<string> {
    const snapshotDir = join(dirname(this.workDir), ".snapshots");
    const snapshotPath = join(snapshotDir, `${this.id}-${Date.now().toString(36)}`);
    await mkdir(snapshotDir, { recursive: true });
    await cp(this.workDir, snapshotPath, { force: true, recursive: true });
    return snapshotPath;
  }

  async stop(): Promise<void> {
    for (const child of this.activeChildren) {
      child.kill("SIGTERM");
    }
    this.activeChildren.clear();
  }

  async destroy(): Promise<void> {
    await this.stop();
    await rm(this.workDir, { recursive: true, force: true });
  }

  private resolveInsideSandbox(path: string): string {
    const absolutePath = resolve(this.workDir, path);
    const relativePath = relative(this.workDir, absolutePath);
    if (relativePath.startsWith("..")) {
      throw new Error(`Path "${path}" escapes sandbox root.`);
    }
    return absolutePath;
  }

  private resolveCommandCwd(cwd: string | undefined): string {
    if (!cwd || cwd === ".") {
      return this.workDir;
    }

    return isAbsolute(cwd) ? cwd : this.resolveInsideSandbox(cwd);
  }
}

function findExecutableOnPath(command: string): string | null {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  const extensions = platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""];
  for (const baseDir of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(baseDir, command + extension);
      if (isExecutableCandidate(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function isExecutableCandidate(candidate: string): boolean {
  return existsSync(candidate);
}

function needsShellSpawn(executablePath: string): boolean {
  if (platform !== "win32") {
    return false;
  }

  const normalized = executablePath.toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".ps1");
}

function resolveSpawnCommand(command: string): { command: string; prependArgs: string[] } {
  const executablePath = isAbsolute(command) ? command : (findExecutableOnPath(command) ?? command);

  if (!needsShellSpawn(executablePath)) {
    return { command: executablePath, prependArgs: [] };
  }

  try {
    const content = existsSync(executablePath) ? readFileSync(executablePath, "utf8") : "";
    const match = content.match(/"?%dp0%[\\\/]?(node_modules[\\\/][^"]+\.js)"?/);
    if (match) {
      const jsPath = join(dirname(executablePath), match[1].replace(/%\*/g, "").trim());
      if (existsSync(jsPath)) {
        return { command: process.execPath, prependArgs: [jsPath] };
      }
    }
  } catch {
    // Fall back to spawning the wrapper directly.
  }

  return { command: executablePath, prependArgs: [] };
}
