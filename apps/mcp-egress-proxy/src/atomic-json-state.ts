import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonStateFile(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`MCP egress state file is unreadable: ${path}`, { cause: error });
  }
}

export function writeJsonStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryFile = `${path}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryFile, path);
}
