import type { PrismaCutoverSloSnapshot } from "./cutover-slo.ts";
import { DEFAULT_WORKSPACE_ID, getDatabase } from "../database.ts";
import { PRISMA_CUTOVER_SLO_SNAPSHOT_CODE } from "./cutover-slo-store.ts";

export type PrismaShadowReadinessReason =
  | "no_snapshots"
  | "invalid_window"
  | "insufficient_coverage"
  | "stale_coverage"
  | "coverage_gap"
  | "insufficient_samples"
  | "mismatch_observed"
  | "fallback_observed"
  | "error_observed"
  | "deadlock_rate_exceeded"
  | "p2034_rate_exceeded"
  | "rollback_recommended";

export interface PrismaCutoverShadowReadinessReport {
  domain: string;
  ready: boolean;
  requiredWindowDays: number;
  maximumGapSeconds: number;
  windowStart?: string;
  windowEnd?: string;
  sampleCount: number;
  reasons: PrismaShadowReadinessReason[];
}

/** Evaluate persisted SLO snapshots before a shadow domain may enter write cutover. */
export function assessPrismaCutoverShadowReadiness(input: {
  domain: string;
  snapshots: readonly PrismaCutoverSloSnapshot[];
  now?: string;
  requiredWindowDays?: number;
  maximumGapSeconds?: number;
  minimumSamples?: number;
  maximumDeadlockRate?: number;
  maximumP2034Rate?: number;
}): PrismaCutoverShadowReadinessReport {
  const domain = input.domain.trim();
  if (!domain) throw new Error("prisma_shadow_readiness.domain_required");
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("prisma_shadow_readiness.now_invalid");
  const requiredWindowDays = boundedInteger(input.requiredWindowDays, 30, 1, 365);
  const maximumGapSeconds = boundedInteger(input.maximumGapSeconds, 1_800, 0, 86_400);
  const minimumSamples = boundedInteger(input.minimumSamples, 1, 1, Number.MAX_SAFE_INTEGER);
  const maximumDeadlockRate = boundedRate(input.maximumDeadlockRate, 0);
  const maximumP2034Rate = boundedRate(input.maximumP2034Rate, 0);
  const reasons = new Set<PrismaShadowReadinessReason>();
  const windows = input.snapshots
    .filter((snapshot) => snapshot.domain === domain)
    .map((snapshot) => ({
      snapshot,
      startMs: Date.parse(snapshot.windowStart ?? ""),
      endMs: Date.parse(snapshot.windowEnd ?? ""),
    }))
    .filter((window) => {
      const valid = Number.isFinite(window.startMs) && Number.isFinite(window.endMs)
        && window.startMs <= window.endMs && window.endMs <= nowMs;
      if (!valid) reasons.add("invalid_window");
      return valid;
    })
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  if (windows.length === 0) reasons.add("no_snapshots");
  const cutoffMs = nowMs - requiredWindowDays * 86_400_000;
  const gapMs = maximumGapSeconds * 1_000;
  let coverageEnd = windows[0]?.endMs;
  if (windows[0] && windows[0].startMs > cutoffMs) reasons.add("insufficient_coverage");
  for (const window of windows.slice(1)) {
    if (coverageEnd !== undefined && window.startMs > coverageEnd + gapMs) reasons.add("coverage_gap");
    coverageEnd = Math.max(coverageEnd ?? window.endMs, window.endMs);
  }
  if (coverageEnd !== undefined && coverageEnd < nowMs - gapMs) reasons.add("stale_coverage");

  const sampleCount = windows.reduce((sum, window) => sum + window.snapshot.sampleCount, 0);
  if (sampleCount < minimumSamples) reasons.add("insufficient_samples");
  if (windows.some(({ snapshot }) => snapshot.mismatchRate > 0)) reasons.add("mismatch_observed");
  if (windows.some(({ snapshot }) => snapshot.fallbackRate > 0)) reasons.add("fallback_observed");
  if (windows.some(({ snapshot }) => snapshot.errorRate > 0)) reasons.add("error_observed");
  if (windows.some(({ snapshot }) => snapshot.deadlockRate > maximumDeadlockRate)) reasons.add("deadlock_rate_exceeded");
  if (windows.some(({ snapshot }) => snapshot.p2034Rate > maximumP2034Rate)) reasons.add("p2034_rate_exceeded");
  if (windows.some(({ snapshot }) => snapshot.rollbackRecommended || snapshot.rollbackReasons.length > 0)) {
    reasons.add("rollback_recommended");
  }

  const result: PrismaCutoverShadowReadinessReport = {
    domain,
    ready: reasons.size === 0,
    requiredWindowDays,
    maximumGapSeconds,
    sampleCount,
    reasons: [...reasons],
  };
  if (windows[0]) result.windowStart = new Date(windows[0].startMs).toISOString();
  if (coverageEnd !== undefined) result.windowEnd = new Date(coverageEnd).toISOString();
  return result;
}

/** Load the complete bounded evidence window from the central audit ledger. */
export function assessPersistedPrismaCutoverShadowReadinessSync(input: {
  domain: string;
  workspaceId?: string;
  now?: string;
  requiredWindowDays?: number;
  maximumGapSeconds?: number;
  minimumSamples?: number;
  maximumDeadlockRate?: number;
  maximumP2034Rate?: number;
}): PrismaCutoverShadowReadinessReport {
  const now = input.now ?? new Date().toISOString();
  const requiredWindowDays = boundedInteger(input.requiredWindowDays, 30, 1, 365);
  const maximumGapSeconds = boundedInteger(input.maximumGapSeconds, 1_800, 0, 86_400);
  const createdFrom = new Date(
    Date.parse(now) - requiredWindowDays * 86_400_000 - maximumGapSeconds * 1_000,
  ).toISOString();
  const rows = getDatabase().prepare(
    `SELECT data_json AS "dataJson"
       FROM audit_log
      WHERE workspace_id = ? AND code = ? AND created_at >= ?
        AND data_json ->> 'domain' = ?
      ORDER BY created_at ASC
      LIMIT 10000`,
  ).all(
    input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
    createdFrom,
    input.domain,
  ) as Array<{ dataJson: unknown }>;
  const snapshots = rows.flatMap((row) => {
    try {
      const parsed = typeof row.dataJson === "string" ? JSON.parse(row.dataJson) : row.dataJson;
      return parsed && typeof parsed === "object" ? [parsed as PrismaCutoverSloSnapshot] : [];
    } catch {
      return [];
    }
  });
  return assessPrismaCutoverShadowReadiness({ ...input, now, requiredWindowDays, maximumGapSeconds, snapshots });
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value as number));
}

function boundedRate(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value as number));
}
