import { resolve } from "node:path";
import {
  DEFAULT_SANDBOX_TASK_TIMEOUT_MS,
  SANDBOX_TASK_TIMEOUT_ENV,
  resolveSandboxTaskTimeoutMs,
} from "../types.ts";
import type { SandboxConnectOptions, SandboxProvider } from "../types.ts";

export const SANDBOX_PROVIDER_ENV = "DOFE_AGENT_SANDBOX_PROVIDER";
export const LEGACY_SANDBOX_PROVIDER_ENV = "SANDBOX_PROVIDER";
export const CUBE_API_URL_ENV = "DOFE_AGENT_CUBE_API_URL";
export const LEGACY_CUBE_API_URL_ENV = "E2B_API_URL";
export const CUBE_API_KEY_ENV = "DOFE_AGENT_CUBE_API_KEY";
export const LEGACY_CUBE_API_KEY_ENV = "E2B_API_KEY";
export const CUBE_TEMPLATE_ID_ENV = "DOFE_AGENT_CUBE_TEMPLATE_ID";
export const LEGACY_CUBE_TEMPLATE_ID_ENV = "CUBE_TEMPLATE_ID";
export const CUBE_EXPERIMENTAL_ENABLE_ENV = "DOFE_AGENT_CUBE_ENABLE_EXPERIMENTAL";
export const CUBE_TIMEOUT_SECONDS_ENV = "DOFE_AGENT_CUBE_TIMEOUT_SECONDS";
export const CUBE_ALLOW_INTERNET_ENV = "DOFE_AGENT_CUBE_ALLOW_INTERNET";
export const CUBE_ALLOW_OUT_ENV = "DOFE_AGENT_CUBE_ALLOW_OUT";
export const CUBE_DENY_OUT_ENV = "DOFE_AGENT_CUBE_DENY_OUT";
export const CUBE_MOUNT_WORKDIR_ENV = "DOFE_AGENT_CUBE_MOUNT_WORKDIR";
export const CUBE_MOUNT_PATH_ENV = "DOFE_AGENT_CUBE_MOUNT_PATH";
export const CUBE_HOST_MOUNT_METADATA_KEY = "host-mount";
export const DEFAULT_CUBE_MOUNT_PATH = "/workspace";
export const DEFAULT_CUBE_API_REQUEST_TIMEOUT_MS = 30_000;

export interface CubeSandboxNetworkConfig {
  allowOut?: string[];
  denyOut?: string[];
}

export interface CubeSandboxHostMount {
  hostPath: string;
  mountPath: string;
  readOnly: boolean;
}

export interface CubeSandboxConfig {
  apiUrl: string;
  apiKey: string;
  templateId: string;
  timeoutSeconds: number;
  allowInternetAccess?: boolean;
  network?: CubeSandboxNetworkConfig;
  requestTimeoutMs: number;
  runtimeId: string;
  workDir: string;
  mountWorkDir: boolean;
  mountPath: string;
  metadata: Record<string, string>;
}

export function resolveSandboxProvider(options: SandboxConnectOptions): SandboxProvider {
  const env = options.env ?? process.env;
  const rawValue = options.provider ?? env[SANDBOX_PROVIDER_ENV] ?? env[LEGACY_SANDBOX_PROVIDER_ENV] ?? "local";
  const provider = rawValue.trim().toLowerCase();

  if (provider === "cube" && parseOptionalBoolean(env[CUBE_EXPERIMENTAL_ENABLE_ENV]) !== true) {
    throw new Error(
      `CubeSandbox is still experimental. Set ${CUBE_EXPERIMENTAL_ENABLE_ENV}=true to enable the lifecycle scaffold explicitly.`,
    );
  }

  if (provider === "local" || provider === "cube") {
    return provider;
  }

  throw new Error(
    `Unsupported sandbox provider "${rawValue}". Use "local" or "cube" via ${SANDBOX_PROVIDER_ENV} or ${LEGACY_SANDBOX_PROVIDER_ENV}.`,
  );
}

export function resolveCubeSandboxConfig(options: SandboxConnectOptions): CubeSandboxConfig {
  const env = options.env ?? process.env;
  const apiUrl = readRequiredEnv(env, [CUBE_API_URL_ENV, LEGACY_CUBE_API_URL_ENV]);
  const apiKey = readRequiredEnv(env, [CUBE_API_KEY_ENV, LEGACY_CUBE_API_KEY_ENV]);
  const templateId = readRequiredEnv(env, [CUBE_TEMPLATE_ID_ENV, LEGACY_CUBE_TEMPLATE_ID_ENV]);
  const explicitTimeoutSeconds = env[CUBE_TIMEOUT_SECONDS_ENV]
    ? readPositiveInteger(env[CUBE_TIMEOUT_SECONDS_ENV], CUBE_TIMEOUT_SECONDS_ENV)
    : undefined;
  const timeoutMs = explicitTimeoutSeconds
    ? explicitTimeoutSeconds * 1000
    : resolveSandboxTaskTimeoutMs(env[SANDBOX_TASK_TIMEOUT_ENV] ?? DEFAULT_SANDBOX_TASK_TIMEOUT_MS);
  const timeoutSeconds = explicitTimeoutSeconds ?? Math.max(1, Math.ceil(timeoutMs / 1000));
  const allowInternetAccess = parseOptionalBoolean(env[CUBE_ALLOW_INTERNET_ENV]);
  const mountWorkDir = parseOptionalBoolean(env[CUBE_MOUNT_WORKDIR_ENV]) ?? false;
  const mountPath = normalizeMountPath(env[CUBE_MOUNT_PATH_ENV] ?? DEFAULT_CUBE_MOUNT_PATH);
  const workDir = resolve(options.workDir);
  const metadata: Record<string, string> = {
    "dofe-agent.runtime-id": options.runtimeId,
    "dofe-agent.work-dir": workDir,
  };

  if (mountWorkDir) {
    const hostMount: CubeSandboxHostMount[] = [{
      hostPath: workDir,
      mountPath,
      readOnly: false,
    }];
    metadata[CUBE_HOST_MOUNT_METADATA_KEY] = JSON.stringify(hostMount);
    metadata["dofe-agent.mount-path"] = mountPath;
  }

  return {
    apiUrl: trimTrailingSlash(apiUrl),
    apiKey,
    templateId,
    timeoutSeconds,
    allowInternetAccess,
    network: buildNetworkConfig(env),
    requestTimeoutMs: DEFAULT_CUBE_API_REQUEST_TIMEOUT_MS,
    runtimeId: options.runtimeId,
    workDir,
    mountWorkDir,
    mountPath,
    metadata,
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  throw new Error(`CubeSandbox requires ${names.join(" or ")} to be set.`);
}

function readPositiveInteger(raw: string, name: string): number {
  const parsed = parsePositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function buildNetworkConfig(env: NodeJS.ProcessEnv): CubeSandboxNetworkConfig | undefined {
  const allowOut = parseList(env[CUBE_ALLOW_OUT_ENV]);
  const denyOut = parseList(env[CUBE_DENY_OUT_ENV]);

  if (!allowOut && !denyOut) {
    return undefined;
  }

  return {
    allowOut,
    denyOut,
  };
}

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeMountPath(raw: string): string {
  const normalized = raw.trim().replace(/\\+/g, "/");
  if (!normalized || normalized === "/") {
    return "/";
  }

  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withRoot.replace(/\/+$/, "") || "/";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
