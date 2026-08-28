import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRepositoryRoot(input?: {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}): string | null {
  const env = input?.env ?? process.env;
  const candidates = [
    env.DOFE_AGENT_REPOSITORY_ROOT,
    input?.startDir,
    /*turbopackIgnore: true*/ process.cwd(),
    join(/*turbopackIgnore: true*/ process.cwd(), ".."),
    join(/*turbopackIgnore: true*/ process.cwd(), "..", ".."),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    const markerRoot = findRepositoryRootByWalking(resolved);
    if (markerRoot) {
      return markerRoot;
    }
  }

  return null;
}

export function resolveRepositoryRoot(input?: {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}): string {
  return findRepositoryRoot(input) ?? /*turbopackIgnore: true*/ process.cwd();
}

export function resolveRepositoryEnvFilePath(input?: {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}): string | null {
  const root = findRepositoryRoot(input);
  return root ? join(root, ".env") : null;
}

export function readRepositoryEnvValues(input?: {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}): Record<string, string> {
  const envFilePath = resolveRepositoryEnvFilePath(input);
  if (!envFilePath || !existsSync(/*turbopackIgnore: true*/ envFilePath)) {
    return {};
  }

  return parseDotEnv(readFileSync(/*turbopackIgnore: true*/ envFilePath, "utf8"));
}

export function readRepositoryEnvValue(
  name: string,
  input?: {
    env?: NodeJS.ProcessEnv;
    startDir?: string;
  },
): string | undefined {
  const value = readRepositoryEnvValues(input)[name]?.trim();
  return value || undefined;
}

export function readEffectiveRuntimeEnv(input?: {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
  repositoryOverridesEnv?: boolean;
}): NodeJS.ProcessEnv {
  const env = input?.env ?? process.env;
  const repositoryEnv = readRepositoryEnvValues({ env, startDir: input?.startDir });
  const repositoryOverridesEnv = input?.repositoryOverridesEnv ?? shouldRepositoryOverrideRuntimeEnv(env);
  return repositoryOverridesEnv
    ? { ...env, ...repositoryEnv }
    : { ...repositoryEnv, ...env };
}

export function loadRepositoryEnvIntoProcess(input?: {
  env?: NodeJS.ProcessEnv;
  startDir?: string;
  override?: boolean;
}): void {
  const env = input?.env ?? process.env;
  const override = input?.override ?? true;
  const repositoryEnv = readRepositoryEnvValues({ env, startDir: input?.startDir });
  for (const [key, value] of Object.entries(repositoryEnv)) {
    if (!override && env[key] !== undefined) {
      continue;
    }
    env[key] = value;
  }
}

function shouldRepositoryOverrideRuntimeEnv(env: NodeJS.ProcessEnv): boolean {
  const configured = env.DOFE_AGENT_REPOSITORY_ENV_OVERRIDE?.trim().toLowerCase();
  if (configured === "0" || configured === "false") {
    return false;
  }
  if (configured === "1" || configured === "true") {
    return true;
  }
  return env === process.env;
}

function findRepositoryRootByWalking(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    if (existsSync(/*turbopackIgnore: true*/ join(currentDir, "Target.md"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawKey = trimmed.slice(0, separatorIndex).trim();
    const key = rawKey.startsWith("export ") ? rawKey.slice("export ".length).trim() : rawKey;
    if (!key) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
