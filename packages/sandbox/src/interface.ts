import type { ExecCommand, ExecResult, FileEntry, SandboxStatus } from "./types.ts";

export interface Sandbox {
  readonly id: string;
  readonly status: SandboxStatus;

  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  readDir(path: string): Promise<FileEntry[]>;
  exists(path: string): Promise<boolean>;
  exec(command: ExecCommand): Promise<ExecResult>;
  snapshot(): Promise<string>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}
