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
  /** CAS link 冲突率上限（workflow_node_queue_link_conflict），对应 link_conflict_spike。 */
  maximumLinkConflictRate?: number;
}

export interface PrismaCutoverSloSnapshot {
  domain: string;
  sampleCount: number;
  mismatchRate: number;
  shadowComparisonRate?: number;
  fallbackRate: number;
  errorRate: number;
  p95DurationMs: number;
  deadlockRate: number;
  p2034Rate: number;
  /** CAS link 冲突率。可选：2026-08 前持久化的历史快照没有该字段。 */
  linkConflictRate?: number;
  burnRate: number;
  rollbackRecommended: boolean;
  /**
   * event_order_drift 仅有类型声明：写路径尚无 shadow 事件序列对照基础设施
   * （runDomainWriteCutover 无 compare 通道），采集依赖 shadow 写对照落地后补齐，
   * 本次修复有意延后（复审 P2 记录）。
   */
  rollbackReasons: Array<
    | "mismatch_rate"
    | "fallback_rate"
    | "error_rate"
    | "p95_duration"
    | "deadlock_rate"
    | "p2034_rate"
    | "link_conflict_spike"
    | "event_order_drift"
  >;
  flagVersion?: string;
  lastKnownGoodFlagVersion?: string;
  instanceId?: string;
  windowStart?: string;
  windowEnd?: string;
}

interface CutoverSloSample {
  /** 样本权重：单次调用为 1，批次调用为批次条目数。 */
  sampleCount: number;
  mismatchCount: number;
  shadowComparedCount: number;
  fallbackCount: number;
  errorCount: number;
  deadlockCount: number;
  p2034Count: number;
  linkConflictCount: number;
  durationMs: number;
}

/** 单批次权重上限，防止异常批次淹没整个窗口的比率。 */
const MAXIMUM_SAMPLE_WEIGHT = 10_000;

function normalizedSampleWeight(metric: CutoverMetric): number {
  const fields = metric as unknown as Record<string, unknown>;
  const declared = Number(fields.sampleCount);
  let weight = Number.isFinite(declared) && declared > 0 ? declared : 1;
  for (const field of ["errorCount", "deadlockCount", "p2034Count", "linkConflictCount"] as const) {
    const count = Number(fields[field]);
    if (Number.isFinite(count) && count > 0) weight = Math.max(weight, count);
  }
  return Math.min(MAXIMUM_SAMPLE_WEIGHT, weight);
}

/**
 * 空批次判定：显式声明 sampleCount<=0 且无任何失败/冲突/回退信号。
 * 空闲轮询没有写出任何条目，不构成对写路径正确性的观测——记入窗口只会
 * 虚增样本数并稀释错误率（复审 P1：实测空批次生成了 sampleCount=1 的零错误快照）。
 */
function isEmptyBatchMetric(metric: CutoverMetric): boolean {
  const fields = metric as unknown as Record<string, unknown>;
  if (fields.sampleCount === undefined) return false;
  const declared = Number(fields.sampleCount);
  if (!Number.isFinite(declared) || declared > 0) return false;
  if (metric.error !== undefined || metric.fallbackFailed === 1 || metric.mismatch === 1) return false;
  if (metric.source === "fallback") return false;
  for (const field of ["errorCount", "deadlockCount", "p2034Count", "linkConflictCount"] as const) {
    const count = Number(fields[field]);
    if (Number.isFinite(count) && count > 0) return false;
  }
  return true;
}

function normalizedCount(value: number | undefined, weight: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.min(value, weight) : 0;
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
    if (isEmptyBatchMetric(metric)) return;
    const samples = this.samplesByDomain.get(domain) ?? [];
    const weight = normalizedSampleWeight(metric);
    const declared = metric as Partial<Pick<DomainWriteCutoverMetric, "errorCount" | "deadlockCount" | "p2034Count" | "linkConflictCount">>;
    const errorDerived = metric.error !== undefined || metric.fallbackFailed === 1 ? weight : 0;
    samples.push({
      sampleCount: weight,
      mismatchCount: metric.mismatch === 1 ? weight : 0,
      shadowComparedCount: metric.shadowCompared === 1 ? weight : 0,
      fallbackCount: metric.source === "fallback" || ("fallbackInvoked" in metric && metric.fallbackInvoked === 1) ? weight : 0,
      errorCount: declared.errorCount !== undefined
        ? normalizedCount(declared.errorCount, weight) || errorDerived
        : errorDerived,
      deadlockCount: declared.deadlockCount !== undefined
        ? normalizedCount(declared.deadlockCount, weight)
        : isDeadlockError(metric.error) ? weight : 0,
      p2034Count: declared.p2034Count !== undefined
        ? normalizedCount(declared.p2034Count, weight)
        : isP2034Error(metric.error) ? weight : 0,
      linkConflictCount: declared.linkConflictCount !== undefined
        ? normalizedCount(declared.linkConflictCount, weight)
        : isLinkConflictError(metric.error) ? weight : 0,
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

  /** 按域清空：flush 逐域落账成功后立即移除该域样本，失败域留给下次重试。 */
  resetDomain(domain: string): void {
    this.samplesByDomain.delete(domain.trim());
  }
}

export interface CutoverSloRates {
  mismatchRate: number;
  fallbackRate: number;
  errorRate: number;
  p95DurationMs: number;
  deadlockRate: number;
  p2034Rate: number;
  linkConflictRate?: number;
}

export interface CutoverSloRollbackVerdict {
  burnRate: number;
  rollbackReasons: PrismaCutoverSloSnapshot["rollbackReasons"];
  rollbackRecommended: boolean;
}

/**
 * 阈值判定：burn rate 取各 rate/阈值比的最大值，样本量达标后逐项生成回滚原因。
 * summarizeDomain（单实例窗口）与 aggregatePrismaCutoverSloSnapshots（跨实例
 * 汇总）共用本函数——汇总后必须用聚合 rate 重新判定，不能直接并集实例级
 * reason，否则多实例各自不足最小样本、合计超阈值时会漏报，单个小实例异常
 * 也会造成汇总误报（复审 P1）。
 */
export function evaluateCutoverSloRollback(
  rates: CutoverSloRates,
  sampleCount: number,
  thresholds: PrismaCutoverSloThresholds,
): CutoverSloRollbackVerdict {
  const thresholdRatios = [
    ratio(rates.mismatchRate, thresholds.maximumMismatchRate),
    ratio(rates.fallbackRate, thresholds.maximumFallbackRate),
    ratio(rates.errorRate, thresholds.maximumErrorRate),
    ratio(rates.deadlockRate, thresholds.maximumDeadlockRate),
    ratio(rates.p2034Rate, thresholds.maximumP2034Rate),
    ratio(rates.linkConflictRate ?? 0, thresholds.maximumLinkConflictRate),
  ];
  const burnRate = Math.max(0, ...thresholdRatios);
  const rollbackReasons: PrismaCutoverSloSnapshot["rollbackReasons"] = [];
  if (sampleCount >= thresholds.minimumSamples) {
    if (rates.mismatchRate > thresholds.maximumMismatchRate) rollbackReasons.push("mismatch_rate");
    if (rates.fallbackRate > thresholds.maximumFallbackRate) rollbackReasons.push("fallback_rate");
    if (rates.errorRate > thresholds.maximumErrorRate) rollbackReasons.push("error_rate");
    if (rates.p95DurationMs > thresholds.maximumP95DurationMs) rollbackReasons.push("p95_duration");
    if (thresholds.maximumDeadlockRate !== undefined && rates.deadlockRate > thresholds.maximumDeadlockRate) {
      rollbackReasons.push("deadlock_rate");
    }
    if (thresholds.maximumP2034Rate !== undefined && rates.p2034Rate > thresholds.maximumP2034Rate) {
      rollbackReasons.push("p2034_rate");
    }
    if (
      thresholds.maximumLinkConflictRate !== undefined &&
      (rates.linkConflictRate ?? 0) > thresholds.maximumLinkConflictRate
    ) {
      rollbackReasons.push("link_conflict_spike");
    }
  }
  return { burnRate, rollbackReasons, rollbackRecommended: rollbackReasons.length > 0 };
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
  const sampleCount = samples.reduce((sum, sample) => sum + sample.sampleCount, 0);
  const count = (selector: (sample: CutoverSloSample) => number): number =>
    samples.reduce((sum, sample) => sum + selector(sample), 0);
  const mismatchRate = rate(count((sample) => sample.mismatchCount), sampleCount);
  const shadowComparisonRate = rate(count((sample) => sample.shadowComparedCount), sampleCount);
  const fallbackRate = rate(count((sample) => sample.fallbackCount), sampleCount);
  const errorRate = rate(count((sample) => sample.errorCount), sampleCount);
  const deadlockRate = rate(count((sample) => sample.deadlockCount), sampleCount);
  const p2034Rate = rate(count((sample) => sample.p2034Count), sampleCount);
  const linkConflictRate = rate(count((sample) => sample.linkConflictCount), sampleCount);
  const p95DurationMs = percentile95(samples.map((sample) => ({ value: sample.durationMs, weight: sample.sampleCount })));
  const verdict = evaluateCutoverSloRollback(
    { mismatchRate, fallbackRate, errorRate, p95DurationMs, deadlockRate, p2034Rate, linkConflictRate },
    sampleCount,
    input.thresholds,
  );
  const snapshot: PrismaCutoverSloSnapshot = {
    domain,
    sampleCount,
    mismatchRate,
    shadowComparisonRate,
    fallbackRate,
    errorRate,
    p95DurationMs,
    deadlockRate,
    p2034Rate,
    linkConflictRate,
    burnRate: verdict.burnRate,
    rollbackRecommended: verdict.rollbackRecommended,
    rollbackReasons: verdict.rollbackReasons,
    flagVersion: input.flagVersion?.trim() || undefined,
    lastKnownGoodFlagVersion: input.lastKnownGoodFlagVersion?.trim() || undefined,
  };
  if (input.instanceId?.trim()) snapshot.instanceId = input.instanceId.trim();
  if (input.windowStart?.trim()) snapshot.windowStart = input.windowStart.trim();
  if (input.windowEnd?.trim()) snapshot.windowEnd = input.windowEnd.trim();
  return snapshot;
}

function percentile95(entries: { value: number; weight: number }[]): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return 0;
  // 第 95 百分位：累计权重首次达到或超过总权重 95% 的最小值。
  const threshold = totalWeight * 0.95;
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= threshold) return entry.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
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

function isLinkConflictError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes("workflow_node_queue_link_conflict");
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
    ["maximumLinkConflictRate", thresholds.maximumLinkConflictRate],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`${name} must be between 0 and 1.`);
    }
  }
}
