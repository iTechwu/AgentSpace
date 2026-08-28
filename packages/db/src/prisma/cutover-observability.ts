import type { DomainWriteCutoverMetric } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import {
  PrismaCutoverSloWindow,
  type PrismaCutoverSloSnapshot,
  type PrismaCutoverSloThresholds,
} from "./cutover-slo.ts";
import {
  persistPrismaCutoverSloSnapshotsSync,
  type PersistedPrismaCutoverSloSnapshot,
} from "./cutover-slo-store.ts";

export interface PrismaCutoverMetricContext {
  domain: string;
  operation: string;
}

interface PrismaCutoverMetricOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  logger?: Pick<Console, "info" | "warn">;
  sloWindow?: PrismaCutoverSloWindow;
}

type CutoverMetric = ReadCutoverMetric | DomainWriteCutoverMetric;
const sharedSloWindow = new PrismaCutoverSloWindow();

export function createPrismaCutoverMetricSink(
  context: PrismaCutoverMetricContext,
): (metric: CutoverMetric) => void {
  return (metric) => emitPrismaCutoverMetric(context, metric);
}

export function emitPrismaCutoverMetric(
  context: PrismaCutoverMetricContext,
  metric: CutoverMetric,
  options: PrismaCutoverMetricOptions = {},
): void {
  const env = options.env ?? process.env;
  if (env.PRISMA_CUTOVER_METRICS_ENABLED !== "1") return;
  (options.sloWindow ?? sharedSloWindow).record(context, metric);

  const weighted = metric as Partial<Pick<DomainWriteCutoverMetric, "sampleCount" | "errorCount" | "deadlockCount" | "p2034Count" | "eventOrder">>;
  const batchFailureCount = weighted.errorCount ?? 0;
  const batchConflictCount = (weighted.deadlockCount ?? 0) + (weighted.p2034Count ?? 0);
  const eventOrder = weighted.eventOrder;
  const eventOrderDriftCount = eventOrder?.driftCount ?? 0;
  const abnormal = metric.source === "fallback" || metric.mismatch === 1
    || metric.error !== undefined || batchFailureCount > 0 || batchConflictCount > 0 || eventOrderDriftCount > 0;
  if (!abnormal && (options.random ?? Math.random)() >= readSuccessSampleRate(env)) return;

  const record: Record<string, string | number> = {
    eventCode: "prisma.cutover",
    domain: context.domain,
    operation: context.operation,
    source: metric.source,
    mismatch: metric.mismatch,
    durationMs: Math.max(0, metric.durationMs),
  };
  if (metric.shadowCompared !== undefined) record.shadowCompared = metric.shadowCompared;
  if ("fallbackInvoked" in metric) record.fallbackInvoked = metric.fallbackInvoked;
  if (metric.fallbackFailed !== undefined) record.fallbackFailed = metric.fallbackFailed;
  if (weighted.sampleCount !== undefined) record.sampleCount = weighted.sampleCount;
  if (batchFailureCount > 0) record.errorCount = batchFailureCount;
  if (batchConflictCount > 0) {
    if (weighted.deadlockCount !== undefined && weighted.deadlockCount > 0) record.deadlockCount = weighted.deadlockCount;
    if (weighted.p2034Count !== undefined && weighted.p2034Count > 0) record.p2034Count = weighted.p2034Count;
  }
  if (eventOrder && eventOrder.comparedCount > 0) {
    record.eventOrderComparedCount = eventOrder.comparedCount;
    record.eventOrderDriftCount = eventOrder.driftCount;
  }
  // Error messages can contain connection details. The application error path
  // keeps the original exception; telemetry only records its presence.
  if (metric.error !== undefined) record.error = "present";

  const logger = options.logger ?? console;
  const line = JSON.stringify(record);
  if (abnormal) logger.warn(line);
  else logger.info(line);
}

export function readPrismaCutoverSloSnapshots(input: {
  thresholds: PrismaCutoverSloThresholds;
  flagVersion?: string;
  lastKnownGoodFlagVersion?: string;
}): PrismaCutoverSloSnapshot[] {
  return sharedSloWindow.snapshots(input);
}

/**
 * Flushes one bounded SLO window to the central ledger. Callers should invoke
 * this from a scheduled maintenance context and provide a stable instanceId;
 * the store's domain/window idempotency key makes retries safe.
 */
export function flushPrismaCutoverSloSnapshotsSync(input: {
  thresholds: PrismaCutoverSloThresholds;
  instanceId: string;
  workspaceId?: string;
  flagVersion?: string;
  lastKnownGoodFlagVersion?: string;
  windowStart?: string;
  windowEnd?: string;
  now?: string;
  resetAfterFlush?: boolean;
  sloWindow?: PrismaCutoverSloWindow;
  persist?: typeof persistPrismaCutoverSloSnapshotsSync;
}): PersistedPrismaCutoverSloSnapshot[] {
  const window = input.sloWindow ?? sharedSloWindow;
  const persist = input.persist ?? persistPrismaCutoverSloSnapshotsSync;
  const snapshots = window.snapshots({
    thresholds: input.thresholds,
    flagVersion: input.flagVersion,
    lastKnownGoodFlagVersion: input.lastKnownGoodFlagVersion,
    instanceId: input.instanceId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd ?? input.now,
  });
  // 逐域落账：某域写入成功立即清空该域样本，失败域留给下一周期以新
  // windowEnd 重写。若整体成功后才统一 reset，部分失败会把已落账域的
  // 样本带着新 windowEnd 再写一遍（幂等键含 windowEnd）——同域重复计数。
  const persisted: PersistedPrismaCutoverSloSnapshot[] = [];
  for (const snapshot of snapshots) {
    const [row] = persist({
      snapshots: [snapshot],
      instanceId: input.instanceId,
      workspaceId: input.workspaceId,
      now: input.now,
    });
    if (row) persisted.push(row);
    if (input.resetAfterFlush !== false) window.resetDomain(snapshot.domain);
  }
  return persisted;
}

export function resetPrismaCutoverSloWindowForTests(): void {
  sharedSloWindow.reset();
}

function readSuccessSampleRate(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.PRISMA_CUTOVER_SUCCESS_SAMPLE_RATE ?? "0.01");
  if (!Number.isFinite(parsed)) return 0.01;
  return Math.min(1, Math.max(0, parsed));
}
