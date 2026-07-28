import type { ModelsInternalUsageLogEntry } from "@dofe/models-sdk";

export type NormalizedModelsUsageLogEntry = ModelsInternalUsageLogEntry & {
  cacheTokens?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  updatedAt?: string | null;
};

export function normalizeModelsUsageLogEntry(
  input: ModelsInternalUsageLogEntry | Record<string, unknown>,
): NormalizedModelsUsageLogEntry {
  const value = input as ModelsInternalUsageLogEntry & Record<string, unknown>;
  const cacheTokens = firstFiniteNonNegative(value.cacheTokens, value.cachedTokens)
    ?? sumFiniteNonNegative(value.cacheReadTokens, value.cacheWriteTokens);
  return {
    ...value,
    cacheTokens,
    startedAt: readOptionalString(value.startedAt),
    endedAt: readOptionalString(value.endedAt),
    updatedAt: readOptionalString(value.updatedAt),
  } as NormalizedModelsUsageLogEntry;
}

function firstFiniteNonNegative(...values: unknown[]): number | undefined {
  return values.find((value): value is number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  ));
}

function sumFiniteNonNegative(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  ));
  return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
