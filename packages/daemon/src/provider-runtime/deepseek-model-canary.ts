import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentRouter, type AgentRouterEvent } from "../agent-router/index.ts";
import { resolveDeepSeekJsonRpcReleaseConfig } from "./deepseek-jsonrpc-release.ts";
import type { ProviderRuntimeRecord } from "./types.ts";

const CANARY_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
const CANARY_RESPONSE = "DOFE_DEEPSEEK_CANARY_OK";
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_CANARY_TIMEOUT_MS = 120_000;

interface CanaryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface DeepSeekNativeModelCanaryEvidence {
  schemaVersion: 1;
  kind: "deepseek-native-model-canary-evidence";
  checkedAt: string;
  imageDigest: string;
  release: {
    sourceCommit: string;
    wheelSha256: string;
    executableSha256: string;
    ripgrepSha256: string;
    spawnHelperSha256?: string;
    cordisConfigSha256: string;
  };
  protocol: "deepseek_native";
  serverInfo: { name: "deepseek-harness-sdk-runtime"; version: "0.0.1" };
  endpoint: { kind: "official" } | { kind: "configured"; baseUrlSha256: string };
  attestation: { kind: "cosign-public-key"; publicKeySha256: string };
  models: Array<{
    id: typeof CANARY_MODELS[number];
    status: "passed";
    usage: CanaryUsage;
  }>;
}

export async function generateDeepSeekNativeModelCanaryEvidence(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DeepSeekNativeModelCanaryEvidence> {
  const imageDigest = environment.DOFE_AGENT_DEEPSEEK_RUNTIME_IMAGE_DIGEST?.trim().toLowerCase() ?? "";
  if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
    throw new Error("DeepSeek model canary requires an immutable DOFE_AGENT_DEEPSEEK_RUNTIME_IMAGE_DIGEST.");
  }
  const apiKey = environment.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DeepSeek model canary requires DEEPSEEK_API_KEY.");
  const publicKeySha256 = environment.DOFE_AGENT_DEEPSEEK_COSIGN_PUBLIC_KEY_SHA256?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(publicKeySha256)) {
    throw new Error("DeepSeek model canary requires an attested cosign public-key digest.");
  }

  const runtime: ProviderRuntimeRecord = {
    id: "deepseek-native-model-canary",
    workspaceId: "release-verification",
    provider: "deepseek-harness",
    name: "DeepSeek native model canary",
    status: "online",
    metadata: {
      executablePath: environment.DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE?.trim() ?? "",
      mode: "remote",
      provisioningState: "managed",
    },
  };
  const release = resolveDeepSeekJsonRpcReleaseConfig(runtime, environment);
  if (!release?.provenancePath || !release.sourceCommit || !release.wheelSha256) {
    throw new Error("DeepSeek model canary requires a complete managed release configuration.");
  }

  const timeoutMs = resolveCanaryTimeout(environment.DOFE_AGENT_DEEPSEEK_MODEL_CANARY_TIMEOUT_MS);
  const endpoint = resolveEndpointEvidence(environment.DEEPSEEK_BASE_URL);
  const workDir = mkdtempSync(join(tmpdir(), "dofe-deepseek-model-canary-"));
  try {
    const models: DeepSeekNativeModelCanaryEvidence["models"] = [];
    for (const model of CANARY_MODELS) {
      const result = await runAgentRouter({
        version: 1,
        harness: "deepseek-harness",
        prompt: `Reply with exactly ${CANARY_RESPONSE}. Do not call tools.`,
        cwd: workDir,
        executablePath: release.executablePath,
        model,
        mode: "jsonrpc",
        deepSeekJsonRpcEnabled: true,
        deepSeekJsonRpcReleasePolicy: release,
        deepSeekJsonRpcIsolatedEnvironment: true,
        env: buildCanaryEnvironment(environment, release.cordisConfigPath, apiKey),
        timeoutMs,
      });
      if (result.status !== "completed" || result.outputText?.trim() !== CANARY_RESPONSE) {
        throw new Error(`DeepSeek model canary failed for ${model}.`);
      }
      const usage = readCanaryUsage(result.events, model);
      models.push({ id: model, status: "passed", usage });
    }

    return {
      schemaVersion: 1,
      kind: "deepseek-native-model-canary-evidence",
      checkedAt: new Date().toISOString(),
      imageDigest,
      release: {
        sourceCommit: release.sourceCommit,
        wheelSha256: release.wheelSha256,
        executableSha256: release.executableSha256,
        ripgrepSha256: release.ripgrepSha256,
        ...(release.spawnHelperSha256 ? { spawnHelperSha256: release.spawnHelperSha256 } : {}),
        cordisConfigSha256: release.cordisConfigSha256,
      },
      protocol: "deepseek_native",
      serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
      endpoint,
      attestation: { kind: "cosign-public-key", publicKeySha256 },
      models,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function resolveEndpointEvidence(baseUrl: string | undefined): DeepSeekNativeModelCanaryEvidence["endpoint"] {
  const configured = baseUrl?.trim();
  if (!configured) return { kind: "official" };
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("DeepSeek model canary DEEPSEEK_BASE_URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("DeepSeek model canary DEEPSEEK_BASE_URL must be credential-free HTTPS without query or fragment.");
  }
  return {
    kind: "configured",
    baseUrlSha256: createHash("sha256").update(configured).digest("hex"),
  };
}

function buildCanaryEnvironment(
  environment: NodeJS.ProcessEnv,
  cordisConfigPath: string,
  apiKey: string,
): Record<string, string> {
  const result: Record<string, string> = {
    DSH_CORDIS_CONFIG: cordisConfigPath,
    DEEPSEEK_API_KEY: apiKey,
  };
  for (const key of [
    "DEEPSEEK_BASE_URL",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ]) {
    const value = environment[key]?.trim();
    if (value) result[key] = value;
  }
  return result;
}

function readCanaryUsage(events: AgentRouterEvent[], model: string): CanaryUsage {
  if (events.some((event) => event.type === "tool_started" || event.type === "tool_finished"
    || (event.type === "tool_output" && event.tool !== "usage"))) {
    throw new Error(`DeepSeek model canary observed an unexpected tool event for ${model}.`);
  }
  const usageEvents = events.filter(
    (event): event is Extract<AgentRouterEvent, { type: "tool_output" }> => event.type === "tool_output" && event.tool === "usage",
  );
  if (usageEvents.length !== 1) {
    throw new Error(`DeepSeek model canary requires exactly one usage event for ${model}.`);
  }
  const metadata = asRecord(usageEvents[0].metadata);
  if (!metadata || !isTokenCount(metadata.input_tokens) || !isTokenCount(metadata.output_tokens)) {
    throw new Error(`DeepSeek model canary received invalid usage for ${model}.`);
  }
  const optionalFields = ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const;
  for (const key of optionalFields) {
    if (metadata[key] !== undefined && !isTokenCount(metadata[key])) {
      throw new Error(`DeepSeek model canary received invalid usage for ${model}.`);
    }
  }
  return {
    inputTokens: metadata.input_tokens,
    outputTokens: metadata.output_tokens,
    ...(metadata.cache_read_tokens === undefined ? {} : { cacheReadTokens: metadata.cache_read_tokens as number }),
    ...(metadata.cache_write_tokens === undefined ? {} : { cacheWriteTokens: metadata.cache_write_tokens as number }),
    ...(metadata.reasoning_tokens === undefined ? {} : { reasoningTokens: metadata.reasoning_tokens as number }),
  };
}

function resolveCanaryTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_CANARY_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 10 * 60_000) {
    throw new Error("DOFE_AGENT_DEEPSEEK_MODEL_CANARY_TIMEOUT_MS must be an integer between 1000 and 600000.");
  }
  return timeout;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
