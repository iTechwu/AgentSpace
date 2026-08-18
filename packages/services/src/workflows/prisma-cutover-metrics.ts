import {
  emitPrismaCutoverMetric,
  flushPrismaCutoverSloSnapshotsSync,
  runWithPrismaTransactionRetryCapture,
  type EventOrderObservation,
  type PrismaTransactionRetryEvent,
} from "@dofe-agent/db";
import { readSloThresholdsFromEnv } from "../shared/slo-thresholds.ts";

/** Record a Prisma workflow write without claiming that a shadow comparison ran. */
export async function observeWorkflowPrismaWrite<T>(
  context: { domain: "workflow-dispatcher" | "workflow-materialization"; operation: string },
  operation: () => Promise<T>,
  options: {
    emitMetric?: typeof emitPrismaCutoverMetric;
    now?: () => number;
    /** 从批次结果归纳样本数与失败数；缺省按单样本记录。 */
    summarizeResult?: (result: T) => WorkflowPrismaBatchSummary;
  } = {},
): Promise<T> {
  const emitMetric = options.emitMetric ?? emitPrismaCutoverMetric;
  const now = options.now ?? Date.now;
  // 事务冲突事件按本次调用的异步上下文捕获：并发批次互不串扰，
  // 事件精确归属触发它的这次 operation（含成功重试与耗尽终态）。
  const events: PrismaTransactionRetryEvent[] = [];
  const startedAt = now();
  try {
    const result = await runWithPrismaTransactionRetryCapture(events, operation);
    const summary = options.summarizeResult?.(result);
    const conflicts = domainConflictCounts(events, context.domain);
    const shadowComparison = summary?.shadowComparison;
    emitMetric(context, {
      source: "primary",
      mismatch: shadowComparison && shadowComparison.mismatchCount > 0 ? 1 : 0,
      shadowCompared: shadowComparison && shadowComparison.comparedCount > 0 ? 1 : 0,
      durationMs: now() - startedAt,
      fallbackInvoked: 0,
      sampleCount: summary?.sampleCount ?? 1,
      errorCount: summary?.errorCount ?? 0,
      ...(summary?.eventOrder && summary.eventOrder.comparedCount > 0
        ? { eventOrder: summary.eventOrder }
        : {}),
      ...(shadowComparison ? { shadowComparison } : {}),
      deadlockCount: conflicts.deadlock,
      p2034Count: conflicts.p2034,
    });
    return result;
  } catch (error) {
    const conflicts = domainConflictCounts(events, context.domain);
    // 冲突计数仅在大于 0 时声明：为 0 时省略字段，让窗口层按错误消息
    // 分类兜底（直抛的 P2034/40P01 不经 retry 包装也要进对应冲突率）。
    emitMetric(context, {
      source: "primary",
      mismatch: 0,
      shadowCompared: 0,
      durationMs: now() - startedAt,
      fallbackInvoked: 0,
      error: error instanceof Error ? error.message : String(error),
      sampleCount: 1,
      errorCount: 1,
      ...(conflicts.deadlock > 0 || conflicts.p2034 > 0
        ? { deadlockCount: conflicts.deadlock, p2034Count: conflicts.p2034 }
        : {}),
    });
    throw error;
  }
}

export interface WorkflowPrismaBatchSummary {
  /** 批次内实际尝试写出的条目数（租约冲突等未尝试项不计入）。 */
  sampleCount: number;
  /** 批次内结构化失败的条目数。 */
  errorCount: number;
  /** 批次内 router/queue 事件顺序的对照样本与漂移计数。 */
  eventOrder?: EventOrderObservation;
  /** 五对象 workflow dispatch shadow 对照结果。 */
  shadowComparison?: {
    comparedCount: number;
    mismatchCount: number;
    diffFields?: string[];
  };
}

function domainConflictCounts(
  events: readonly PrismaTransactionRetryEvent[],
  domain: string,
): { deadlock: number; p2034: number } {
  let deadlock = 0;
  let p2034 = 0;
  // 非本域事件（如嵌套调用的 coordinator 域写路径）不归入本域样本。
  for (const event of events) {
    if (event.scope !== domain) continue;
    if (event.kind === "deadlock") deadlock += 1;
    else p2034 += 1;
  }
  return { deadlock, p2034 };
}

/**
 * workflow worker 进程内 SLO 窗口落账：指标样本产生于 worker 进程的
 * sharedSloWindow，Web/maintenance 进程的 cron flush 刷不到它，必须由
 * worker 自己按节流周期写入集中 audit ledger（instanceId 区分进程，
 * 幂等键由 store 保证重试安全）。
 */
export function flushWorkflowWorkerPrismaCutoverSloSync(input: {
  instanceId: string;
  windowStart?: string;
  now?: string;
}): number {
  const now = input.now ?? new Date().toISOString();
  return flushPrismaCutoverSloSnapshotsSync({
    thresholds: readSloThresholdsFromEnv(),
    instanceId: input.instanceId,
    workspaceId: process.env.PRISMA_CUTOVER_SLO_WORKSPACE_ID?.trim() || "default",
    windowStart: input.windowStart,
    windowEnd: now,
    now,
  }).length;
}
