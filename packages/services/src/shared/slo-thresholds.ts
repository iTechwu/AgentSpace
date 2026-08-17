import type { PrismaCutoverSloThresholds } from "@dofe-agent/db";

/**
 * 通用环境变量数值解析。抽出 shared 层供配置读取复用，避免各模块重复实现
 * 相同的最小/最大/回退逻辑。
 */
export function readBoundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function readRate(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * SLO 阈值统一读入口（独立配置模块）：maintenance flush 与 workflow worker
 * 进程内 flush 共用。抽出 shared 层是为了让 workflows 的指标模块不必
 * 依赖整个 runtime-maintenance 模块（依赖单向：域 → shared）。
 */
export function readSloThresholdsFromEnv(): PrismaCutoverSloThresholds {
  return {
    minimumSamples: readBoundedNumber(process.env.PRISMA_CUTOVER_SLO_MINIMUM_SAMPLES, 10, 1, 100_000),
    maximumMismatchRate: readRate(process.env.PRISMA_CUTOVER_SLO_MAX_MISMATCH_RATE, 0.01),
    maximumFallbackRate: readRate(process.env.PRISMA_CUTOVER_SLO_MAX_FALLBACK_RATE, 0.05),
    maximumErrorRate: readRate(process.env.PRISMA_CUTOVER_SLO_MAX_ERROR_RATE, 0.01),
    maximumP95DurationMs: readBoundedNumber(process.env.PRISMA_CUTOVER_SLO_MAX_P95_MS, 2_000, 0, 600_000),
    maximumDeadlockRate: readRate(process.env.PRISMA_CUTOVER_SLO_MAX_DEADLOCK_RATE, 0.001),
    maximumP2034Rate: readRate(process.env.PRISMA_CUTOVER_SLO_MAX_P2034_RATE, 0.001),
  };
}
