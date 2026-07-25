import {
  PROVIDER_ERROR_CODES,
  type ProviderErrorCode,
  type ProviderHealthStatus,
  type ProviderUsabilityStatus,
  type RuntimeOnlineStatus,
  type RuntimeProviderHealth,
} from "@dofe-agent/domain";

export interface NormalizeRuntimeProviderHealthInput {
  runtimeStatus: RuntimeOnlineStatus;
  runtimeMetadata: Record<string, unknown>;
  lastError?: string;
}

export function normalizeRuntimeProviderHealth(input: NormalizeRuntimeProviderHealthInput): RuntimeProviderHealth {
  const healthMetadata = readHealthMetadata(input.runtimeMetadata);
  const providerHealth = healthMetadata.status ?? "unknown";
  const providerUsable = resolveProviderUsable(input.runtimeStatus, providerHealth);
  const lastProviderErrorMessage =
    healthMetadata.errorMessage
    ?? (providerUsable === "unusable" ? input.lastError : undefined);

  return {
    runtimeStatus: input.runtimeStatus,
    providerHealth,
    providerUsable,
    providerHealthReason: healthMetadata.reason ?? defaultProviderHealthReason(input.runtimeStatus, providerHealth),
    lastHealthCheckedAt: healthMetadata.checkedAt,
    lastProviderErrorCode: healthMetadata.errorCode,
    lastProviderErrorMessage,
    rawProviderMessage: healthMetadata.rawProviderMessage,
  };
}

function resolveProviderUsable(
  runtimeStatus: RuntimeOnlineStatus,
  providerHealth: ProviderHealthStatus,
): ProviderUsabilityStatus {
  if (runtimeStatus === "offline" || providerHealth === "broken") {
    return "unusable";
  }
  if (providerHealth === "healthy" || providerHealth === "degraded") {
    return "usable";
  }
  return "unverified";
}

function defaultProviderHealthReason(
  runtimeStatus: RuntimeOnlineStatus,
  providerHealth: ProviderHealthStatus,
): string | undefined {
  if (runtimeStatus === "offline") {
    return "Runtime is offline; provider usability cannot be checked.";
  }
  if (providerHealth === "unknown") {
    return "Provider health has not been checked yet.";
  }
  if (providerHealth === "degraded") {
    return "Provider is degraded.";
  }
  if (providerHealth === "broken") {
    return "Provider is currently unavailable.";
  }
  return undefined;
}

function readHealthMetadata(metadata: Record<string, unknown>): {
  status?: ProviderHealthStatus;
  reason?: string;
  checkedAt?: string;
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  rawProviderMessage?: string;
} {
  const nested = readObject(metadata.providerHealth);
  const source = nested ?? metadata;

  return {
    status: readProviderHealthStatus(readValue(source, "status", "providerHealth")),
    reason: readString(readValue(source, "reason", "providerHealthReason")),
    checkedAt: readString(readValue(source, "checkedAt", "lastHealthCheckedAt")),
    errorCode: readProviderErrorCode(readValue(readObject(source.error) ?? source, "code", "lastProviderErrorCode")),
    errorMessage: readString(readValue(readObject(source.error) ?? source, "message", "lastProviderErrorMessage")),
    rawProviderMessage: readString(readValue(readObject(source.error) ?? source, "rawProviderMessage")),
  };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readValue(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in source) {
      return source[key];
    }
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readProviderHealthStatus(value: unknown): ProviderHealthStatus | undefined {
  return value === "unknown" || value === "healthy" || value === "degraded" || value === "broken"
    ? value
    : undefined;
}

function readProviderErrorCode(value: unknown): ProviderErrorCode | undefined {
  return typeof value === "string" && PROVIDER_ERROR_CODES.includes(value as ProviderErrorCode)
    ? value as ProviderErrorCode
    : undefined;
}
