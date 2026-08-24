// 3.5-4：自 provider-runtime.ts 拆出——节点心跳元数据、runtime 注册元数据
//（含 openclaw/CLI 健康验证触发）与 agent-router provider 环境组装。
import { arch, platform, version as nodeVersion } from "node:process";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { buildOpenClawProviderHealthSnapshot, inspectOpenClawDaemonAuthHealth } from "../openclaw-health.ts";
import { readCliHubReadiness } from "../runtime-apps.ts";
import { inspectProviderCliHealth, requiresProviderVerification } from "./health.ts";
import { buildProviderEnv } from "./provider-env.ts";
import type { ProviderRuntimeRecord } from "./types.ts";

export function readNodeMetadata(serverUrl: string, runtimeName: string, runtimes: ProviderRuntimeRecord[] = [], managedNode?: boolean): Record<string, unknown> {
  return {
    mode: managedNode ? "managed" : "remote",
    managedNode: managedNode ?? false,
    pid: String(process.pid),
    runtimeName,
    nodeVersion,
    platform,
    arch,
    serverUrl,
    cliHubReadiness: readCliHubReadiness(),
    providerHealth: Object.fromEntries(
      runtimes
        .map((runtime) => [runtime.id, readRuntimeProviderHealthMetadata(runtime)] as const)
        .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof readRuntimeProviderHealthMetadata>>] => Boolean(entry[1])),
    ),
  };
}

export function buildProviderRuntimeMetadata(
  runtime: Pick<ProviderRuntimeRecord, "provider" | "metadata">,
  options: { environment?: Record<string, string> } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    executablePath: runtime.metadata.executablePath,
    mode: runtime.metadata.mode,
  };
  if (runtime.provider === "openclaw") {
    const environment = options.environment ? { ...process.env, ...options.environment } : process.env;
    const profile = environment.OPENCLAW_PROFILE?.trim();
    const model = environment.OPENCLAW_MODEL?.trim();
    const health = inspectOpenClawDaemonAuthHealth({
      env: environment,
      profile,
      model,
    });
    return {
      ...base,
      openClawProfile: profile,
      openClawModel: model,
      providerHealth: buildOpenClawProviderHealthSnapshot(health),
    };
  }
  if (requiresProviderVerification(runtime)) {
    return {
      ...base,
      providerHealth: inspectProviderCliHealth(runtime, options.environment),
    };
  }
  return base;
}

export function readRuntimeProviderHealthMetadata(runtime: ProviderRuntimeRecord): ReturnType<typeof buildOpenClawProviderHealthSnapshot> | undefined {
  const metadata = runtime.metadata as Record<string, unknown>;
  const providerHealth = metadata.providerHealth;
  if (providerHealth && typeof providerHealth === "object" && !Array.isArray(providerHealth)) {
    return providerHealth as ReturnType<typeof buildOpenClawProviderHealthSnapshot>;
  }
  if (runtime.provider !== "openclaw") {
    return undefined;
  }
  const profile = readRuntimeMetadataString(runtime, "openClawProfile", "openclawProfile") || process.env.OPENCLAW_PROFILE?.trim() || undefined;
  const model = readRuntimeMetadataString(runtime, "openClawModel", "openclawModel") || process.env.OPENCLAW_MODEL?.trim() || undefined;
  return buildOpenClawProviderHealthSnapshot(inspectOpenClawDaemonAuthHealth({
    env: process.env,
    profile,
    model,
  }));
}

export function readRuntimeMetadataString(runtime: ProviderRuntimeRecord, ...keys: string[]): string | undefined {
  const metadata = runtime.metadata as Record<string, unknown>;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function buildAgentRouterProviderEnv(
  runtime: ProviderRuntimeRecord,
  extra?: Record<string, string>,
): Record<string, string> {
  const env = buildProviderEnv(runtime, extra) as Record<string, string>;
  if (runtime.provider === "deepseek-harness") {
    const home = readRuntimeMetadataString(runtime, "deepSeekHarnessHome");
    if (home) env.DSH_HOME = home;
    return env;
  }
  if (runtime.provider !== "openclaw") {
    return env;
  }
  const profile = readRuntimeMetadataString(runtime, "openClawProfile", "openclawProfile");
  const model = readRuntimeMetadataString(runtime, "openClawModel", "openclawModel");
  if (profile) {
    env.DOFE_AGENT_OPENCLAW_PROFILE_OVERRIDE = profile;
  }
  if (model) {
    env.DOFE_AGENT_OPENCLAW_MODEL_OVERRIDE = model;
  }
  return env;
}
