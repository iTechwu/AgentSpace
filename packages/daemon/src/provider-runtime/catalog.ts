// 3.5-4：自 provider-runtime.ts 拆出——provider 目录（命令/默认模型/版本
// 参数）、allowlist 过滤的本机探测与 modelId 解析。
import type { DaemonProvider } from "@dofe-agent/domain";
import { formatDaemonProviderLabel, isDaemonProvider } from "@dofe-agent/domain";
import {
  detectProviderVersion,
  findFirstExecutableOnPath,
  resolveProviderCommands,
  warnClaudeRootRuntimeIfNeeded,
} from "./executables.ts";
import { readRuntimeMetadataString } from "./metadata.ts";
import type { DetectedProvider, ProviderRuntimeRecord } from "./types.ts";

const PROVIDER_CATALOG: Array<{
  provider: DaemonProvider;
  label: string;
  command?: string;
  commands?: string[];
  defaultModelId?: string;
  versionArgs?: string[][];
}> = [
  { provider: "codex", label: formatDaemonProviderLabel("codex"), command: "codex" },
  {
    provider: "claude",
    label: formatDaemonProviderLabel("claude"),
    command: "claude",
    defaultModelId: "claude-haiku-4-5-20251001",
  },
  {
    provider: "antigravity",
    label: formatDaemonProviderLabel("antigravity"),
    commands: ["agy", "antigravity"],
    versionArgs: [["--version"], ["version"]],
  },
  {
    provider: "gemini",
    label: formatDaemonProviderLabel("gemini"),
    command: "gemini",
    defaultModelId: "gemini-2.0-flash-lite",
  },
  {
    provider: "opencode",
    label: formatDaemonProviderLabel("opencode"),
    command: "opencode",
    defaultModelId: "opencode-default",
  },
  {
    provider: "openclaw",
    label: formatDaemonProviderLabel("openclaw"),
    command: "openclaw",
  },
  {
    provider: "nanobot",
    label: formatDaemonProviderLabel("nanobot"),
    command: "nanobot",
    defaultModelId: "nanobot-default",
  },
  {
    provider: "hermes",
    label: formatDaemonProviderLabel("hermes"),
    commands: ["hermes-agent", "hermes"],
    versionArgs: [["--version"], ["version"]],
  },
];

export function detectProviders(): DetectedProvider[] {
  const allowedProviders = readProviderAllowlist();
  return PROVIDER_CATALOG
    .filter((candidate) => !allowedProviders || allowedProviders.has(candidate.provider))
    .map((candidate) => {
      const executablePath = findFirstExecutableOnPath(resolveProviderCommands(candidate));
      if (!executablePath) {
        return null;
      }
      if (candidate.provider === "claude") {
        warnClaudeRootRuntimeIfNeeded("detected");
      }

      return {
        provider: candidate.provider,
        label: candidate.label,
        executablePath,
        version: detectProviderVersion(executablePath, candidate.versionArgs),
      } satisfies DetectedProvider;
    })
    .filter((value): value is DetectedProvider => value !== null);
}

function readProviderAllowlist(): Set<DaemonProvider> | undefined {
  const configured = process.env.DOFE_AGENT_RUNTIME_PROVIDER?.trim();
  if (!configured) {
    return undefined;
  }

  const providers = configured
    .split(",")
    .map((provider) => provider.trim())
    .filter(isDaemonProvider);
  return new Set(providers);
}

export function resolveModelId(runtime: ProviderRuntimeRecord): string | undefined {
  const providerDefinition = PROVIDER_CATALOG.find((candidate) => candidate.provider === runtime.provider);
  if (runtime.provider === "codex") return process.env.CODEX_MODEL?.trim() || undefined;
  if (runtime.provider === "claude") return process.env.CLAUDE_MODEL || providerDefinition?.defaultModelId || "claude-haiku-4-5-20251001";
  if (runtime.provider === "gemini") return process.env.GEMINI_MODEL || providerDefinition?.defaultModelId || "gemini-2.0-flash-lite";
  if (runtime.provider === "antigravity") return process.env.ANTIGRAVITY_MODEL?.trim() || undefined;
  if (runtime.provider === "opencode") return process.env.OPENCODE_MODEL || providerDefinition?.defaultModelId || "opencode-default";
  if (runtime.provider === "openclaw") return readRuntimeMetadataString(runtime, "openClawModel", "openclawModel") || process.env.OPENCLAW_MODEL?.trim() || undefined;
  if (runtime.provider === "nanobot") return process.env.NANOBOT_MODEL || providerDefinition?.defaultModelId || "nanobot-default";
  if (runtime.provider === "hermes") return process.env.HERMES_MODEL?.trim() || process.env.HERMES_INFERENCE_MODEL?.trim() || undefined;
  return providerDefinition?.defaultModelId;
}
