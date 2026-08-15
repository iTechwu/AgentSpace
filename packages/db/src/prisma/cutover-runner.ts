// 通用 cutover-runner 工厂：把 withReadCutover 的 5 项配置（isEnabled /
// isShadowEnabled / runPrimary / runFallback / compare / emitMetric）封装
// 为可注入的闭包，供 Phase 2 各域 cutover wrapper 共用。
//
// 用法：
//   const readFoo = createDomainCutover<FooRecord[]>({
//     isEnabled: () => process.env.FOO_ASYNC_READ === "1",
//     isShadowEnabled: () => process.env.FOO_SHADOW_READ === "1",
//     runPrimary: async () => readFooAsync(...),
//     runFallback: () => readFooSync(...),
//     compare: recordsEqual,
//   });
//   const result = await readFoo();
//
// 或用 buildCutoverReader 包装成「先注入 isEnabled / isShadowEnabled，
// 再注入 runPrimary / runFallback」的两阶段工厂：

import { withReadCutover } from "./read-cutover.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type DomainCutoverCompare<T> = (primary: T, fallback: T) => boolean;
export type DomainCutoverMetric<TMetric extends ReadCutoverMetric = ReadCutoverMetric> = TMetric;

export type { ReadCutoverMetric };

export interface DomainCutoverConfig<T, TMetric extends ReadCutoverMetric = ReadCutoverMetric> {
  isEnabled: () => boolean;
  isShadowEnabled: () => boolean;
  runPrimary: () => Promise<T>;
  runFallback: () => T;
  compare: DomainCutoverCompare<T>;
  emitMetric?: (metric: TMetric) => void;
}

/**
 * Run a single read with the cutover contract. Defaults to the standard
 * ReadCutoverMetric shape; callers can pass a typed metric sink for telemetry.
 */
export async function runDomainCutover<T, TMetric extends ReadCutoverMetric = ReadCutoverMetric>(
  config: DomainCutoverConfig<T, TMetric>,
): Promise<T> {
  return withReadCutover<T>({
    isEnabled: config.isEnabled,
    isShadowEnabled: config.isShadowEnabled,
    runPrimary: config.runPrimary,
    runFallback: config.runFallback,
    compare: config.compare,
    emitMetric: (m) => config.emitMetric?.({ ...m, source: m.source } as TMetric),
  });
}

/**
 * Build a parameterized cutover reader. Returns a function that takes only
 * the per-call inputs (e.g. read options + metric sink) and supplies the
 * pre-bound runPrimary / runFallback closures.
 *
 * The standard Phase 2 domain wrapper looks like:
 *   const readAuditLogCutover = buildDomainCutover<{ id: string; workspaceId?: string }, ...>({
 *     isEnabled: isAuditLogAsyncReadEnabled,
 *     isShadowEnabled: isAuditLogShadowReadEnabled,
 *     runPrimary: (input) => readAuditLogAsync(input),
 *     runFallback: (input) => readAuditLogSync(input.id, input.workspaceId),
 *     compare: recordsEqual,
 *   });
 */
export function buildDomainCutover<TInput, TResult, TMetric extends ReadCutoverMetric = ReadCutoverMetric>(
  config: {
    isEnabled: () => boolean;
    isShadowEnabled: () => boolean;
    runPrimary: (input: TInput) => Promise<TResult>;
    runFallback: (input: TInput) => TResult;
    compare: DomainCutoverCompare<TResult>;
    emitMetric?: (metric: TMetric) => void;
  },
): (input: TInput, metricSink?: (metric: TMetric) => void) => Promise<TResult> {
  return (input, metricSink) =>
    runDomainCutover<TResult, TMetric>({
      isEnabled: config.isEnabled,
      isShadowEnabled: config.isShadowEnabled,
      runPrimary: () => config.runPrimary(input),
      runFallback: () => config.runFallback(input),
      compare: config.compare,
      emitMetric: metricSink ?? config.emitMetric,
    });
}