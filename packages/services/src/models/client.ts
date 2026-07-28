import { createHmac } from "node:crypto";
import { createModelsInternalDataClient, type ModelsInternalDataClient } from "@dofe/models-sdk";
import { resolveModelsBaseUrl } from "../config/deployment.ts";

/**
 * models.dofe.ai internal-API client for AgentSpace.
 *
 * Mirrors the SSO internal-client pattern (baseUrl + serviceName + shared
 * HMAC secret). The bearer signature format must match models.dofe.ai's
 * InternalAuthGuard: `Bearer <ts>:<hmac(secret, `${ts}:${serviceName}`)>:<serviceName>`.
 */

export interface ModelsInternalConfig {
  baseUrl: string;
  serviceName: string;
  secret: string;
}

let cachedClient: ModelsInternalDataClient | null = null;
let cachedConfigKey: string | null = null;

export function resolveModelsInternalConfig(env: NodeJS.ProcessEnv = process.env): ModelsInternalConfig {
  const baseUrl = resolveModelsBaseUrl(env);
  // models.dofe.ai validates the HMAC with its INTERNAL_API_SECRET and allowlists
  // caller service names in MODELS_RUNTIME_CREDENTIAL_SERVICE_NAMES. AgentSpace
  // therefore reuses the platform's shared INTERNAL_API_SECRET and its existing
  // SSO_SERVICE_NAME identity by default; per-target overrides are optional.
  const serviceName = (env.MODELS_SERVICE_NAME ?? env.SSO_SERVICE_NAME ?? "").trim();
  const secret = (env.MODELS_INTERNAL_API_SECRET ?? env.INTERNAL_API_SECRET ?? "").trim();
  if (!serviceName || !secret) {
    throw new Error(
      "models.internal_config_missing: a service name " +
        "(MODELS_SERVICE_NAME or SSO_SERVICE_NAME) and a shared secret " +
        "(MODELS_INTERNAL_API_SECRET or INTERNAL_API_SECRET) are required. models.dofe.ai " +
        "validates with its INTERNAL_API_SECRET; the values must match.",
    );
  }
  return { baseUrl, serviceName, secret };
}

export function buildModelsInternalAuthorization(config: ModelsInternalConfig): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${timestamp}:${config.serviceName}`;
  const signature = createHmac("sha256", config.secret).update(payload).digest("hex");
  return `Bearer ${timestamp}:${signature}:${config.serviceName}`;
}

/**
 * Returns a cached unwrapped models internal client. Rebuilds when the env
 * config changes (so tests can swap env between cases).
 */
export function getModelsInternalClient(env: NodeJS.ProcessEnv = process.env): ModelsInternalDataClient {
  const config = resolveModelsInternalConfig(env);
  const key = `${config.baseUrl}|${config.serviceName}|${config.secret}`;
  if (cachedClient && key === cachedConfigKey) {
    return cachedClient;
  }
  cachedClient = createModelsInternalDataClient({
    baseUrl: config.baseUrl,
    serviceName: config.serviceName,
    getAuthorization: () => buildModelsInternalAuthorization(config),
  });
  cachedConfigKey = key;
  return cachedClient;
}

/** For tests: drop the cached client so the next call re-reads env. */
export function resetModelsInternalClientForTests(): void {
  cachedClient = null;
  cachedConfigKey = null;
}

export function isModelsInternalConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    resolveModelsInternalConfig(env);
    return true;
  } catch {
    return false;
  }
}
