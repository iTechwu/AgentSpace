import { isAbsolute } from "node:path";
import {
  DEEPSEEK_JSONRPC_APPROVED_CORDIS_COMPOSITION,
  DEEPSEEK_JSONRPC_APPROVED_CORDIS_SHA256,
  DEEPSEEK_JSONRPC_SOURCE_COMMIT,
} from "../agent-router/deepseek-jsonrpc-release.ts";
import type { ProviderRuntimeRecord } from "./types.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface DeepSeekJsonRpcReleaseConfig {
  executablePath: string;
  executableSha256: string;
  cordisConfigPath: string;
  cordisConfigSha256: string;
  ripgrepSha256: string;
  spawnHelperSha256?: string;
  provenancePath?: string;
  sourceCommit?: string;
  wheelSha256?: string;
}

export function resolveDeepSeekJsonRpcReleaseConfig(
  runtime: Pick<ProviderRuntimeRecord, "provider" | "metadata">,
  environment: NodeJS.ProcessEnv = process.env,
): DeepSeekJsonRpcReleaseConfig | undefined {
  if (runtime.provider !== "deepseek-harness" || environment.DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED !== "1") {
    return undefined;
  }
  const managedRuntime = Boolean(runtime.metadata.managedCredentialId)
    || runtime.metadata.provisioningState === "managed";
  if (managedRuntime && environment.DOFE_AGENT_DEEPSEEK_JSONRPC_MANAGED_BUNDLE !== "1") {
    throw new Error(
      "DeepSeek Harness JSON-RPC release gate requires an attested in-image bundle for managed container launchers.",
    );
  }

  return readConfiguredDeepSeekJsonRpcRelease(environment);
}

export function readConfiguredDeepSeekJsonRpcRelease(
  environment: NodeJS.ProcessEnv = process.env,
): DeepSeekJsonRpcReleaseConfig | undefined {
  if (environment.DOFE_AGENT_DEEPSEEK_JSONRPC_ENABLED !== "1") return undefined;
  const executablePath = requiredValue(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE");
  const executableSha256 = requiredDigest(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE_SHA256");
  const cordisConfigPath = requiredValue(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_CORDIS_CONFIG");
  const cordisConfigSha256 = requiredDigest(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_CORDIS_CONFIG_SHA256");
  if (cordisConfigSha256 !== DEEPSEEK_JSONRPC_APPROVED_CORDIS_SHA256) {
    throw new Error(
      `DeepSeek Harness JSON-RPC release gate requires the approved ${DEEPSEEK_JSONRPC_APPROVED_CORDIS_COMPOSITION} Cordis composition.`,
    );
  }
  const ripgrepSha256 = requiredDigest(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_RIPGREP_SHA256");
  const spawnHelperSha256 = process.platform === "darwin"
    ? requiredDigest(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_SPAWN_HELPER_SHA256")
    : optionalDigest(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_SPAWN_HELPER_SHA256");
  const managedBundle = environment.DOFE_AGENT_DEEPSEEK_JSONRPC_MANAGED_BUNDLE === "1";
  const provenancePath = managedBundle
    ? requiredValue(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_PROVENANCE")
    : undefined;
  const sourceCommit = managedBundle
    ? requiredValue(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_SOURCE_COMMIT").toLowerCase()
    : undefined;
  const wheelSha256 = managedBundle
    ? requiredDigest(environment, "DOFE_AGENT_DEEPSEEK_JSONRPC_WHEEL_SHA256")
    : undefined;
  if (sourceCommit !== undefined && sourceCommit !== DEEPSEEK_JSONRPC_SOURCE_COMMIT) {
    throw new Error("DeepSeek Harness JSON-RPC release gate requires the approved source commit.");
  }
  if (!isAbsolute(executablePath) || !isAbsolute(cordisConfigPath) || (provenancePath && !isAbsolute(provenancePath))) {
    throw new Error("DeepSeek Harness JSON-RPC release paths must be absolute.");
  }

  return {
    executablePath,
    executableSha256,
    cordisConfigPath,
    cordisConfigSha256,
    ripgrepSha256,
    spawnHelperSha256,
    provenancePath,
    sourceCommit,
    wheelSha256,
  };
}

export function readConfiguredDeepSeekJsonRpcExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readConfiguredDeepSeekJsonRpcRelease(environment)?.executablePath;
}

function requiredValue(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`DeepSeek Harness JSON-RPC release gate requires ${key}.`);
  return value;
}

function requiredDigest(environment: NodeJS.ProcessEnv, key: string): string {
  const value = requiredValue(environment, key).toLowerCase();
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`DeepSeek Harness JSON-RPC release gate requires ${key} to be a 64-character SHA-256 digest.`);
  }
  return value;
}

function optionalDigest(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  return environment[key]?.trim() ? requiredDigest(environment, key) : undefined;
}
