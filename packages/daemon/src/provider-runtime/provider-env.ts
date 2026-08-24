// 3.5-4：自 provider-runtime.ts 拆出——provider 子进程环境构建（托管凭据
// 清空、PATH 注入、daemon-only 键剔除）、日志脱敏与 sandbox exec 封装。
import { delimiter, dirname, join } from "node:path";
import { connectSandbox } from "@dofe-agent/sandbox";
import { buildEnvValueRedactions, buildRedactions, isDaemonOnlyProviderEnvironmentKey, redactText } from "../agent-router/utils.ts";
import { dedupeStrings } from "./executables.ts";
import type { ProviderRuntimeRecord } from "./types.ts";

export function buildProviderEnv(runtime: ProviderRuntimeRecord, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (runtime.metadata.managedCredentialId) {
    // A managed Runtime must never inherit host provider credentials. Its
    // task-scoped credential bundle below is the only source of model auth.
    for (const key of MANAGED_PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS) {
      // Agent Router builds a fresh base from process.env. An explicit empty
      // value survives that second merge and prevents it restoring host keys.
      env[key] = "";
    }
  }
  const currentPath = extra?.PATH ?? env.PATH ?? "";
  env.PATH = ensureProviderPath(currentPath, runtime);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value !== "string") {
        continue;
      }
      env[key] = key === "PATH" ? ensureProviderPath(value, runtime) : value;
    }
  }
  for (const key of Object.keys(env)) {
    if (isDaemonOnlyProviderEnvironmentKey(key)) {
      delete env[key];
    }
  }
  return env;
}

const MANAGED_PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GOOGLE_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCLAW_API_KEY",
  "NANOBOT_API_KEY",
  "HERMES_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
];

// Builds value-based redaction patterns for every secret-named entry in the
// provider env, mirroring the agent-router path (see buildRedactions). Used to
// scrub secret values from provider stdout/stderr before they are stored,
// streamed to clients, or surfaced in error diagnostics.
export function buildProviderRedactions(env: NodeJS.ProcessEnv, skillEnvKeys?: readonly string[]) {
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      stringEnv[key] = value;
    }
  }
  return [...buildRedactions(stringEnv), ...buildEnvValueRedactions(stringEnv, skillEnvKeys)];
}

function ensureProviderPath(pathValue: string, runtime: ProviderRuntimeRecord): string {
  const runtimeBinDirs = dedupeStrings([
    dirname(runtime.metadata.executablePath),
    process.env.DOFE_AGENT_DAEMON_BIN ? dirname(process.env.DOFE_AGENT_DAEMON_BIN) : "",
    process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT ? join(process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT, "bin") : "",
  ]);
  const parts = pathValue.split(delimiter).filter(Boolean);
  const existing = parts.filter((part) => !runtimeBinDirs.includes(part));
  return [...runtimeBinDirs, ...existing].filter(Boolean).join(delimiter);
}

export async function execProviderCommand(
  runtime: ProviderRuntimeRecord,
  args: string[],
  workDir: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  skillEnvKeys?: readonly string[],
  callbacks?: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Awaited<ReturnType<typeof connectSandbox>>["exec"]>>;
}> {
  const sandbox = await connectSandbox({
    runtimeId: runtime.id,
    workDir,
  });

  const providerEnv = buildProviderEnv(runtime, env);
  const redactions = buildProviderRedactions(providerEnv, skillEnvKeys);
  let stdout = "";
  let stderr = "";
  const result = await sandbox.exec({
    command: runtime.metadata.executablePath,
    args,
    timeoutMs,
    env: providerEnv,
    onStdout: (chunk) => {
      const value = redactText(chunk, redactions);
      stdout += value;
      callbacks?.onStdout?.(value);
    },
    onStderr: (chunk) => {
      const value = redactText(chunk, redactions);
      stderr += value;
      callbacks?.onStderr?.(value);
    },
  });

  return { stdout, stderr, result };
}
