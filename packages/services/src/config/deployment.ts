import { readEffectiveRuntimeEnv } from "@dofe-agent/db";

export type AgentRuntimeMode = "local" | "remote";

/**
 * Deployment-level runtime mode. This is deliberately independent from any
 * Runtime record: local instances must never enter managed models flows.
 */
export function resolveAgentRuntimeMode(env: NodeJS.ProcessEnv = process.env): AgentRuntimeMode {
  const value = env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase();
  if (!value || value === "local") return "local";
  if (value === "remote") return "remote";
  throw new Error("DOFE_AGENT_RUNTIME_MODE must be either local or remote.");
}

/**
 * models.dofe.ai endpoints. The control plane (MODELS_BASE_URL, internal API
 * used by AgentSpace) and the data plane (MODELS_GATEWAY_BASE_URL, consumed by
 * managed runtimes to reach the model gateway) share one default origin so a
 * deployment that sets neither still resolves consistently. Per-environment
 * overrides via the env vars are always honored; these constants exist only to
 * avoid scattering the literal `model.local.dofe.ai/api` default across modules.
 */
export const DEFAULT_MODELS_BASE_URL = "https://model.local.dofe.ai/api";
export const DEFAULT_MODELS_GATEWAY_BASE_URL = "https://model.local.dofe.ai/api";

export function resolveModelsBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODELS_BASE_URL?.trim() || DEFAULT_MODELS_BASE_URL;
}

export function resolveModelsGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODELS_GATEWAY_BASE_URL?.trim() || DEFAULT_MODELS_GATEWAY_BASE_URL;
}

export interface AttachmentRuntimeConfig {
  provider: "tos";
  tos: {
    bucket: string;
    endpoint: string;
    publicEndpoint: string;
    bucketDomain?: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export interface DofeAgentRuntimeConfig {
  databaseUrl: string;
  directDatabaseUrl?: string;
  attachments: AttachmentRuntimeConfig;
}

export function resolveDofeAgentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): DofeAgentRuntimeConfig {
  const effectiveEnv = readEffectiveRuntimeEnv({ env, repositoryOverridesEnv: env === process.env });
  return {
    databaseUrl: requireFirstEnvValue(effectiveEnv, ["SELF_HOSTED_DATABASE_URL", "DOFE_AGENT_PG_URL", "DATABASE_URL"]),
    directDatabaseUrl: firstEnvValue(effectiveEnv, ["SELF_HOSTED_DATABASE_DIRECT_URL", "DATABASE_DIRECT_URL"]),
    attachments: resolveAttachmentRuntimeConfig(effectiveEnv),
  };
}

export function resolveAttachmentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AttachmentRuntimeConfig {
  const effectiveEnv = readEffectiveRuntimeEnv({ env, repositoryOverridesEnv: env === process.env });
  const requestedProvider = effectiveEnv.ATTACHMENT_STORAGE_PROVIDER?.trim().toLowerCase();
  if (requestedProvider && requestedProvider !== "tos") {
    throw new Error("ATTACHMENT_STORAGE_PROVIDER must be tos; local attachment storage is not supported.");
  }

  const publicEndpoint = normalizeTosEndpoint(requireFirstEnvValue(effectiveEnv, ["TOS_ENDPOINT", "TOS_S3_ENDPOINT"]));
  const useInternalEndpoint = effectiveEnv.TOS_USE_INTERNAL_ENDPOINT === "true";
  const internalEndpoint = firstEnvValue(effectiveEnv, ["TOS_INTERNAL_ENDPOINT", "TOS_INTERNAL_S3_ENDPOINT"]);
  return {
    provider: "tos",
    tos: {
      bucket: requireFirstEnvValue(effectiveEnv, ["TOS_BUCKET"]),
      endpoint: useInternalEndpoint && internalEndpoint ? internalEndpoint : publicEndpoint,
      publicEndpoint,
      bucketDomain: firstEnvValue(effectiveEnv, ["TOS_BUCKET_DOMAIN"]),
      region: requireFirstEnvValue(effectiveEnv, ["TOS_REGION"]),
      accessKeyId: requireFirstEnvValue(effectiveEnv, ["TOS_ACCESS_KEY"]),
      secretAccessKey: requireFirstEnvValue(effectiveEnv, ["TOS_SECRET_KEY"]),
    },
  };
}

function requireFirstEnvValue(env: NodeJS.ProcessEnv, names: string[]): string {
  const value = firstEnvValue(env, names);
  if (!value) throw new Error(`Missing required environment variable: ${names.join(" or ")}.`);
  return value;
}

function firstEnvValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeTosEndpoint(value: string): string {
  const endpoint = new URL(value.includes("://") ? value : `https://${value}`);
  endpoint.hostname = endpoint.hostname.replace(/^tos-s3-/, "tos-");
  return endpoint.toString().replace(/\/$/, "");
}
