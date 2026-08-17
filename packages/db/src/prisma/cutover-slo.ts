import type { DomainWriteCutoverMetric } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

type CutoverMetric = ReadCutoverMetric | DomainWriteCutoverMetric;

export interface PrismaCutoverSloThresholds {
  minimumSamples: number;
  maximumMismatchRate: number;
  maximumFallbackRate: number;
  maximumErrorRate: number;
  maximumP95DurationMs: number;
  maximumDeadlockRate?: number;
  maximumP2034Rate?: number;
}

export interface PrismaCutoverSloSnapshot {
  domain: string;
  sampleCount: number;
  mismatchRate: number;
  fallbackRate: number;
  errorRate: number;
  p95DurationMs: number;
  deadlockRate: number;
  p2034Rate: number;
  burnRate: number;
  rollbackRecommended: boolean;
  rollbackReasons: Array<
    | "mismatch_rate"
    | "fallback_rate"
    | "error_rate"
    | "p95_duration"
    | "deadlock_rate"
    | "p2034_rate"
  >;
  flagVersion?: string;
  lastKnownGoodFlagVersion?: string;
  instanceId?: string;
  windowStart?: string;
  windowEnd?: string;
}

interface CutoverSloSample {
  mismatch: boolean;
  fallback: boolean;
  error: boolean;
  deadlock: boolean;
  p2034: boolean;
  durationMs: number;
}

export class PrismaCutoverSloWindow {
  private readonly samplesByDomain = new Map<string, CutoverSloSample[]>();
  private readonly maximumSamplesPerDomain: number;

  constructor(maximumSamplesPerDomain = 500) {
    if (!Number.isSafeInteger(maximumSamplesPerDomain) || maximumSamplesPerDomain < 1) {
      throw new Error("maximumSamplesPerDomain must be a positive integer.");
    }
    this.maximumSamplesPerDomain = maximumSamplesPerDomain;
  }

  record(context: { domain: string }, metric: CutoverMetric): void {
    const domain = context.domain.trim();
    if (!domain) return;
    const samples = this.samplesByDomain.get(domain) ?? [];
    samples.push({
      mismatch: metric.mismatch === 1,
      fallback: metric.source === "fallback" || ("fallbackInvoked" in metric && metric.fallbackInvoked === 1),
      error: metric.error !== undefined || metric.fallbackFailed === 1,
      deadlock: isDeadlockError(metric.error),
      p2034: isP2034Error(metric.error),
      durationMs: Math.max(0, metric.durationMs),
    });
    if (samples.length > this.maximumSamplesPerDomain) {
      samples.splice(0, samples.length - this.maximumSamplesPerDomain);
    }
    this.samplesByDomain.set(domain, samples);
  }

  snapshots(input: {
    thresholds: PrismaCutoverSloThresholds;
    flagVersion?: string;
    lastKnownGoodFlagVersion?: string;
    instanceId?: string;
    windowStart?: string;
    windowEnd?: string;
  }): PrismaCutoverSloSnapshot[] {
    validateThresholds(input.thresholds);
    return [...this.samplesByDomain.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([domain, samples]) => summarizeDomain(domain, samples, input));
  }

  reset(): void {
    this.samplesByDomain.clear();
  }
}

function summarizeDomain(
  domain: string,
  samples: CutoverSloSample[],
  input: {
    thresholds: PrismaCutoverSloThresholds;
    flagVersion?: string;
    lastKnownGoodFlagVersion?: string;
    instanceId?: string;
    windowStart?: string;
    windowEnd?: string;
  },
): PrismaCutoverSloSnapshot {
  const sampleCount = samples.length;
  const mismatchRate = rate(samples.filter((sample) => sample.mismatch).length, sampleCount);
  const fallbackRate = rate(samples.filter((sample) => sample.fallback).length, sampleCount);
  const errorRate = rate(samples.filter((sample) => sample.error).length, sampleCount);
  const deadlockRate = rate(samples.filter((sample) => sample.deadlock).length, sampleCount);
  const p2034Rate = rate(samples.filter((sample) => sample.p2034).length, sampleCount);
  const p95DurationMs = percentile95(samples.map((sample) => sample.durationMs));
  const rollbackReasons: PrismaCutoverSloSnapshot["rollbackReasons"] = [];
  const thresholdRatios = [
    ratio(mismatchRate, input.thresholds.maximumMismatchRate),
    ratio(fallbackRate, input.thresholds.maximumFallbackRate),
    ratio(errorRate, input.thresholds.maximumErrorRate),
    ratio(deadlockRate, input.thresholds.maximumDeadlockRate),
    ratio(p2034Rate, input.thresholds.maximumP2034Rate),
  ];
  const burnRate = Math.max(0, ...thresholdRatios);
  if (sampleCount >= input.thresholds.minimumSamples) {
    if (mismatchRate > input.thresholds.maximumMismatchRate) rollbackReasons.push("mismatch_rate");
    if (fallbackRate > input.thresholds.maximumFallbackRate) rollbackReasons.push("fallback_rate");
    if (errorRate > input.thresholds.maximumErrorRate) rollbackReasons.push("error_rate");
    if (p95DurationMs > input.thresholds.maximumP95DurationMs) rollbackReasons.push("p95_duration");
    if (input.thresholds.maximumDeadlockRate !== undefined && deadlockRate > input.thresholds.maximumDeadlockRate) {
      rollbackReasons.push("deadlock_rate");
    }
    if (input.thresholds.maximumP2034Rate !== undefined && p2034Rate > input.thresholds.maximumP2034Rate) {
      rollbackReasons.push("p2034_rate");
    }
  }
  const snapshot: PrismaCutoverSloSnapshot = {
    domain,
    sampleCount,
    mismatchRate,
    fallbackRate,
    errorRate,
    p95DurationMs,
    deadlockRate,
    p2034Rate,
    burnRate,
    rollbackRecommended: rollbackReasons.length > 0,
    rollbackReasons,
    flagVersion: input.flagVersion?.trim() || undefined,
    lastKnownGoodFlagVersion: input.lastKnownGoodFlagVersion?.trim() || undefined,
  };
  if (input.instanceId?.trim()) snapshot.instanceId = input.instanceId.trim();
  if (input.windowStart?.trim()) snapshot.windowStart = input.windowStart.trim();
  if (input.windowEnd?.trim()) snapshot.windowEnd = input.windowEnd.trim();
  return snapshot;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function ratio(value: number, threshold: number | undefined): number {
  if (threshold === undefined || threshold <= 0) return 0;
  return value / threshold;
}

function isDeadlockError(error: string | undefined): boolean {
  return typeof error === "string" && /deadlock detected|40P01/i.test(error);
}

function isP2034Error(error: string | undefined): boolean {
  return typeof error === "string" && /P2034|could not serialize|40001/i.test(error);
}

function validateThresholds(thresholds: PrismaCutoverSloThresholds): void {
  if (!Number.isSafeInteger(thresholds.minimumSamples) || thresholds.minimumSamples < 1) {
    throw new Error("minimumSamples must be a positive integer.");
  }
  for (const [name, value] of [
    ["maximumMismatchRate", thresholds.maximumMismatchRate],
    ["maximumFallbackRate", thresholds.maximumFallbackRate],
    ["maximumErrorRate", thresholds.maximumErrorRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1.`);
  }
  if (!Number.isFinite(thresholds.maximumP95DurationMs) || thresholds.maximumP95DurationMs < 0) {
    throw new Error("maximumP95DurationMs must be non-negative.");
  }
  for (const [name, value] of [
    ["maximumDeadlockRate", thresholds.maximumDeadlockRate],
    ["maximumP2034Rate", thresholds.maximumP2034Rate],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`${name} must be between 0 and 1.`);
    }
  }
}
