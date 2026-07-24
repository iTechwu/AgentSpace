import { readEffectiveRuntimeEnv } from "@agent-space/db";

export interface AttachmentRuntimeConfig {
  provider: "local" | "tos";
  localRoot?: string;
  maxUploadBytes: number;
  signedUrlTtlSeconds: number;
  enableLocalFallback: boolean;
  tos?: {
    bucket: string;
    endpoint: string;
    publicEndpoint: string;
    bucketDomain?: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export interface AgentSpaceRuntimeConfig {
  databaseUrl: string;
  directDatabaseUrl?: string;
  attachments: AttachmentRuntimeConfig;
}

export function resolveAgentSpaceRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AgentSpaceRuntimeConfig {
  const effectiveEnv = readEffectiveRuntimeEnv({ env, repositoryOverridesEnv: env === process.env });
  return {
    databaseUrl: requireFirstEnvValue(effectiveEnv, ["SELF_HOSTED_DATABASE_URL", "AGENT_SPACE_PG_URL", "DATABASE_URL"]),
    directDatabaseUrl: firstEnvValue(effectiveEnv, ["SELF_HOSTED_DATABASE_DIRECT_URL", "DATABASE_DIRECT_URL"]),
    attachments: resolveAttachmentRuntimeConfig(effectiveEnv),
  };
}

export function resolveAttachmentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AttachmentRuntimeConfig {
  const effectiveEnv = readEffectiveRuntimeEnv({ env, repositoryOverridesEnv: env === process.env });
  const maxUploadBytes = readPositiveInteger(effectiveEnv.ATTACHMENT_MAX_UPLOAD_BYTES, 50 * 1024 * 1024);
  const signedUrlTtlSeconds = readPositiveInteger(effectiveEnv.ATTACHMENT_SIGNED_URL_TTL_SECONDS, 300);
  const enableLocalFallback = effectiveEnv.ATTACHMENT_ENABLE_LOCAL_FALLBACK !== "false";
  const requestedProvider = effectiveEnv.ATTACHMENT_STORAGE_PROVIDER?.trim().toLowerCase();
  if (requestedProvider && requestedProvider !== "local" && requestedProvider !== "tos") {
    throw new Error("ATTACHMENT_STORAGE_PROVIDER must be either local or tos.");
  }
  const hasTosConfig = ["TOS_BUCKET", "TOS_REGION", "TOS_ACCESS_KEY", "TOS_SECRET_KEY"].some((name) => Boolean(firstEnvValue(effectiveEnv, [name])));

  if (requestedProvider === "local" || !hasTosConfig) {
    return {
      provider: "local",
      localRoot: firstEnvValue(effectiveEnv, ["ATTACHMENT_LOCAL_ROOT", "SELF_HOSTED_ATTACHMENT_LOCAL_ROOT"]),
      maxUploadBytes,
      signedUrlTtlSeconds,
      enableLocalFallback,
    };
  }

  if (requestedProvider === "tos" || hasTosConfig) {
    const publicEndpoint = normalizeTosEndpoint(requireFirstEnvValue(effectiveEnv, ["TOS_ENDPOINT", "TOS_S3_ENDPOINT"]));
    const useInternalEndpoint = effectiveEnv.TOS_USE_INTERNAL_ENDPOINT === "true";
    const internalEndpoint = firstEnvValue(effectiveEnv, ["TOS_INTERNAL_ENDPOINT", "TOS_INTERNAL_S3_ENDPOINT"]);
    return {
      provider: "tos",
      localRoot: firstEnvValue(effectiveEnv, ["ATTACHMENT_LOCAL_ROOT", "SELF_HOSTED_ATTACHMENT_LOCAL_ROOT"]),
      maxUploadBytes,
      signedUrlTtlSeconds,
      enableLocalFallback,
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

  return {
    provider: "local",
    localRoot: firstEnvValue(effectiveEnv, ["ATTACHMENT_LOCAL_ROOT", "SELF_HOSTED_ATTACHMENT_LOCAL_ROOT"]),
    maxUploadBytes,
    signedUrlTtlSeconds,
    enableLocalFallback,
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

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTosEndpoint(value: string): string {
  const endpoint = new URL(value.includes("://") ? value : `https://${value}`);
  endpoint.hostname = endpoint.hostname.replace(/^tos-s3-/, "tos-");
  return endpoint.toString().replace(/\/$/, "");
}
