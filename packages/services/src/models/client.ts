import { createHmac } from "node:crypto";
import {
  createModelsInternalDataClient,
  type ModelsInternalBillingAggregate,
  type ModelsInternalBillingDimensionAggregate,
  type ModelsInternalBillingLifecycleStatus,
  type ModelsInternalDataClient,
  type ModelsInternalTenantBillingReport,
} from "@dofe/models-sdk";
import { unwrapModelsInternalResponse } from "@dofe/models-sdk/response";
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
  timeoutMs: number;
}

const DEFAULT_MODELS_INTERNAL_API_TIMEOUT_MS = 15_000;
const HTTPS_ONLY_MODELS_HOSTS = new Set(["model.local.dofe.ai"]);

let cachedClient: ModelsInternalDataClient | null = null;
let cachedConfigKey: string | null = null;

export function resolveModelsInternalConfig(env: NodeJS.ProcessEnv = process.env): ModelsInternalConfig {
  const baseUrl = normalizeModelsInternalBaseUrl(resolveModelsBaseUrl(env));
  // models.dofe.ai validates the HMAC with its INTERNAL_API_SECRET and allowlists
  // caller service names in MODELS_RUNTIME_CREDENTIAL_SERVICE_NAMES. AgentSpace
  // therefore reuses the platform's shared INTERNAL_API_SECRET and its existing
  // SSO_SERVICE_NAME identity by default; per-target overrides are optional.
  const serviceName = (env.MODELS_SERVICE_NAME ?? env.SSO_SERVICE_NAME ?? "").trim();
  const secret = (env.MODELS_INTERNAL_API_SECRET ?? env.INTERNAL_API_SECRET ?? "").trim();
  const timeoutValue = env.MODELS_INTERNAL_API_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutValue ? Number(timeoutValue) : DEFAULT_MODELS_INTERNAL_API_TIMEOUT_MS;
  if (!serviceName || !secret) {
    throw new Error(
      "models.internal_config_missing: a service name " +
        "(MODELS_SERVICE_NAME or SSO_SERVICE_NAME) and a shared secret " +
        "(MODELS_INTERNAL_API_SECRET or INTERNAL_API_SECRET) are required. models.dofe.ai " +
        "validates with its INTERNAL_API_SECRET; the values must match.",
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("models.internal_config_invalid: MODELS_INTERNAL_API_TIMEOUT_MS must be a positive number.");
  }
  return { baseUrl, serviceName, secret, timeoutMs };
}

function normalizeModelsInternalBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:" && HTTPS_ONLY_MODELS_HOSTS.has(url.hostname)) {
    url.protocol = "https:";
    return url.toString().replace(/\/$/, "");
  }
  return value;
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
  const key = `${config.baseUrl}|${config.serviceName}|${config.secret}|${config.timeoutMs}`;
  if (cachedClient && key === cachedConfigKey) {
    return cachedClient;
  }
  cachedClient = createModelsInternalDataClient({
    baseUrl: config.baseUrl,
    serviceName: config.serviceName,
    getAuthorization: () => buildModelsInternalAuthorization(config),
    timeoutMs: config.timeoutMs,
  });
  cachedConfigKey = key;
  return cachedClient;
}

export interface ModelsBillingScopePreflightInput {
  scope: {
    tenantId: string;
    ssoTeamId: string;
    teamId: null;
    requestId: string;
    source: "admin";
  };
  estimatedCharge: number;
  reserve: false;
}

export interface ModelsBillingScopePreflightResult {
  allowed: boolean;
  availableBalance?: string | number | null;
  estimatedCharge?: string | number | null;
  currency?: string;
  code?: string;
  message?: string;
}

export type ModelsBillingLifecycleStatus = ModelsInternalBillingLifecycleStatus;
export type ModelsBillingAggregate = ModelsInternalBillingAggregate;
export type ModelsBillingDimensionAggregate = ModelsInternalBillingDimensionAggregate;
export type ModelsTenantBillingReport = ModelsInternalTenantBillingReport;

export interface ModelsTenantBillingReportInput {
  tenantId: string;
  startDate?: string;
  endDate?: string;
  ssoTeamId?: string;
  runtimeCredentialId?: string;
  runtimeId?: string;
  employeeId?: string;
  conversationId?: string;
}

export async function getModelsTenantBillingReportAsync(
  input: ModelsTenantBillingReportInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelsTenantBillingReport> {
  const { tenantId, ...query } = input;
  return getModelsInternalClient(env).usage.tenantBillingReport({
    params: { tenantId },
    query,
  });
}

/**
 * Tenant-first billing preflight. The published SDK still exposes only the
 * deprecated local-team route, so keep this small signed adapter until its v2
 * surface is available in @dofe/models-sdk.
 */
export async function preflightModelsBillingByScopeAsync(
  body: ModelsBillingScopePreflightInput,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<ModelsBillingScopePreflightResult> {
  const config = resolveModelsInternalConfig(env);
  const response = await request(
    `${config.baseUrl.replace(/\/+$/, "")}/internal/billing/v2/preflight`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: buildModelsInternalAuthorization(config),
        "x-service-name": config.serviceName,
      },
      body: JSON.stringify(body),
    },
  );
  const contentType = response.headers.get("content-type") ?? "";
  const responseBody = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return unwrapModelsInternalResponse<ModelsBillingScopePreflightResult>(
    { status: response.status, body: responseBody },
    "POST /internal/billing/v2/preflight",
  );
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
