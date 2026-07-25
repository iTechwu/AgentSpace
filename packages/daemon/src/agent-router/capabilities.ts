import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import type { RuntimeToolCapability } from "@dofe-agent/domain";
import type { AgentRouterDiagnostic } from "./types.ts";
import { createDiagnostic, ensureEnvPath, tailText } from "./utils.ts";

const DEFAULT_TOOL_DIAGNOSTIC_TIMEOUT_MS = 5_000;

export function normalizeRuntimeToolCapabilities(
  capabilities: RuntimeToolCapability[] | undefined,
): RuntimeToolCapability[] {
  if (!capabilities || capabilities.length === 0) {
    return [];
  }
  const result: RuntimeToolCapability[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const command = capability.command.trim();
    const id = capability.id.trim() || command;
    if (!command || !id) {
      continue;
    }
    const normalized: RuntimeToolCapability = {
      ...capability,
      id,
      command,
      displayName: capability.displayName?.trim() || undefined,
      binPath: capability.binPath?.trim() || undefined,
      binDir: capability.binDir?.trim() || undefined,
      pathDirs: normalizeStrings(capability.pathDirs),
      env: normalizeEnv(capability.env),
      allowedShellPatterns: normalizeShellPatterns(capability.allowedShellPatterns, command),
      diagnosticCommands: normalizeStrings(capability.diagnosticCommands),
      requiresApproval: capability.requiresApproval === true,
      status: capability.status,
      denialReason: capability.denialReason?.trim() || undefined,
    };
    const key = normalized.id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function buildCapabilityPathDirs(
  capabilities: RuntimeToolCapability[] | undefined,
): string[] {
  const dirs: string[] = [];
  for (const capability of normalizeRuntimeToolCapabilities(capabilities)) {
    if (capability.status === "denied") {
      continue;
    }
    if (capability.binPath) {
      dirs.push(dirname(capability.binPath));
    }
    if (capability.binDir) {
      dirs.push(capability.binDir);
    }
    dirs.push(...(capability.pathDirs ?? []));
  }
  return dedupeStrings(dirs);
}

export function buildCapabilityEnv(
  baseEnv: Record<string, string>,
  capabilities: RuntimeToolCapability[] | undefined,
): Record<string, string> {
  const env = { ...baseEnv };
  for (const capability of normalizeRuntimeToolCapabilities(capabilities)) {
    if (capability.status === "denied" || !capability.env) {
      continue;
    }
    for (const [key, value] of Object.entries(capability.env)) {
      env[key] = value;
    }
  }
  if (env.PATH) {
    env.PATH = ensureEnvPath(env.PATH, buildCapabilityPathDirs(capabilities));
  }
  return env;
}

export function buildCapabilityAllowedTools(
  capabilities: RuntimeToolCapability[] | undefined,
): string[] {
  const tools: string[] = [];
  for (const capability of normalizeRuntimeToolCapabilities(capabilities)) {
    if (capability.status === "denied") {
      continue;
    }
    for (const pattern of capability.allowedShellPatterns) {
      tools.push(`Bash(${pattern})`);
    }
  }
  return dedupeStrings(tools);
}

export function runCapabilityDiagnostics(input: {
  env: Record<string, string>;
  capabilities: RuntimeToolCapability[] | undefined;
}): AgentRouterDiagnostic[] {
  const diagnostics: AgentRouterDiagnostic[] = [];
  for (const capability of normalizeRuntimeToolCapabilities(input.capabilities)) {
    if (capability.status === "denied") {
      diagnostics.push(createDiagnostic(
        "harness.tool_unauthorized",
        `${capability.displayName ?? capability.command} is not authorized for this task.`,
        {
          severity: "error",
          rawProviderMessage: capability.denialReason,
        },
      ));
      continue;
    }
    if (capability.status === "missing") {
      diagnostics.push(createDiagnostic(
        "harness.tool_missing",
        `${capability.displayName ?? capability.command} is not installed on the runtime.`,
        {
          severity: "error",
          rawProviderMessage: capability.denialReason,
        },
      ));
      continue;
    }
    const commands = capability.diagnosticCommands ?? [];
    if (commands.length === 0) {
      continue;
    }
    for (const command of commands) {
      const result = spawnSync("sh", ["-lc", command], {
        env: input.env,
        encoding: "utf8",
        timeout: DEFAULT_TOOL_DIAGNOSTIC_TIMEOUT_MS,
      });
      if (result.error) {
        diagnostics.push(createDiagnostic(
          "harness.tool_missing",
          `${capability.displayName ?? capability.command} diagnostic failed: ${result.error.message}`,
          {
            severity: "error",
            stderrTail: tailText(`${command}\n${result.error.message}`),
          },
        ));
        continue;
      }
      if (result.status !== 0) {
        diagnostics.push(createDiagnostic(
          "harness.tool_missing",
          `${capability.displayName ?? capability.command} diagnostic failed: ${command}`,
          {
            severity: "error",
            rawProviderMessage: tailText(`${result.stderr ?? ""}\n${result.stdout ?? ""}`),
            stderrTail: tailText(result.stderr ?? result.stdout ?? ""),
          },
        ));
      } else {
        diagnostics.push(createDiagnostic(
          "harness.tool_available",
          `${capability.displayName ?? capability.command} diagnostic passed: ${command}`,
          {
            severity: "info",
            rawProviderMessage: tailText(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
          },
        ));
      }
    }
  }
  return dedupeDiagnostics(diagnostics);
}

function normalizeShellPatterns(patterns: string[], command: string): string[] {
  const normalized = normalizeStrings(patterns);
  return normalized.length > 0 ? normalized : [`${command} *`];
}

function normalizeStrings(values: string[] | undefined): string[] {
  return dedupeStrings((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function normalizeEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.trim() && typeof value === "string") {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function dedupeDiagnostics(diagnostics: AgentRouterDiagnostic[]): AgentRouterDiagnostic[] {
  const result: AgentRouterDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.message,
      diagnostic.rawProviderMessage ?? "",
      diagnostic.stderrTail ?? "",
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
