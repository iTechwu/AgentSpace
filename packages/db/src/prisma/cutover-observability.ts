import type { DomainWriteCutoverMetric } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export interface PrismaCutoverMetricContext {
  domain: string;
  operation: string;
}

interface PrismaCutoverMetricOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
  logger?: Pick<Console, "info" | "warn">;
}

type CutoverMetric = ReadCutoverMetric | DomainWriteCutoverMetric;

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

  const abnormal = metric.source === "fallback" || metric.mismatch === 1 || metric.error !== undefined;
  if (!abnormal && (options.random ?? Math.random)() >= readSuccessSampleRate(env)) return;

  const record: Record<string, string | number> = {
    eventCode: "prisma.cutover",
    domain: context.domain,
    operation: context.operation,
    source: metric.source,
    mismatch: metric.mismatch,
    durationMs: Math.max(0, metric.durationMs),
  };
  if ("fallbackInvoked" in metric) record.fallbackInvoked = metric.fallbackInvoked;
  if (metric.fallbackFailed !== undefined) record.fallbackFailed = metric.fallbackFailed;
  // Error messages can contain connection details. The application error path
  // keeps the original exception; telemetry only records its presence.
  if (metric.error !== undefined) record.error = "present";

  const logger = options.logger ?? console;
  const line = JSON.stringify(record);
  if (abnormal) logger.warn(line);
  else logger.info(line);
}

function readSuccessSampleRate(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.PRISMA_CUTOVER_SUCCESS_SAMPLE_RATE ?? "0.01");
  if (!Number.isFinite(parsed)) return 0.01;
  return Math.min(1, Math.max(0, parsed));
}
