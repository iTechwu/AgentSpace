import {
  emitPrismaCutoverMetric,
  flushPrismaCutoverSloSnapshotsSync,
  setPrismaTransactionRetryObserver,
  type PrismaTransactionRetryEvent,
} from "@dofe-agent/db";
import { readSloThresholdsFromEnv } from "../runtime-maintenance/runtime-maintenance.ts";

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
  // 基线清理：本批次之前遗留的冲突事件（如未观测路径产生）不归入本批次。
  drainConflictCounts();
  const startedAt = now();
  try {
    const result = await operation();
    const summary = options.summarizeResult?.(result);
    const conflicts = takeDomainConflicts(context.domain);
    emitMetric(context, {
      source: "primary",
      mismatch: 0,
      shadowCompared: 0,
      durationMs: now() - startedAt,
      fallbackInvoked: 0,
      sampleCount: summary?.sampleCount ?? 1,
      errorCount: summary?.errorCount ?? 0,
      deadlockCount: conflicts.deadlock,
      p2034Count: conflicts.p2034,
    });
    return result;
  } catch (error) {
    const conflicts = takeDomainConflicts(context.domain);
    emitMetric(context, {
      source: "primary",
      mismatch: 0,
      shadowCompared: 0,
      durationMs: now() - startedAt,
      fallbackInvoked: 0,
      error: error instanceof Error ? error.message : String(error),
      sampleCount: 1,
      errorCount: 1,
      deadlockCount: conflicts.deadlock,
      p2034Count: conflicts.p2034,
    });
    throw error;
  }
}

export interface WorkflowPrismaBatchSummary {
  /** 批次内实际尝试写出的条目数（租约冲突等未尝试项不计入）。 */
  sampleCount: number;
  /** 批次内结构化失败的条目数。 */
  errorCount: number;
}

// 进程级冲突事件缓冲：transaction-retry 观察者在重试发生时立即上报，
// observeWorkflowPrismaWrite 在批次结束时按 domain 认领（ADR 0816/06 第 4 节：
// 成功重试的 P2034/deadlock 必须进入 SLO，而不是被吞成无错样本）。
const conflictEvents: PrismaTransactionRetryEvent[] = [];
setPrismaTransactionRetryObserver((event) => { conflictEvents.push(event); });

function drainConflictCounts(): Map<string, { deadlock: number; p2034: number }> {
  const counts = new Map<string, { deadlock: number; p2034: number }>();
  for (const event of conflictEvents) {
    const entry = counts.get(event.scope) ?? { deadlock: 0, p2034: 0 };
    if (event.kind === "deadlock") entry.deadlock += 1;
    else entry.p2034 += 1;
    counts.set(event.scope, entry);
  }
  conflictEvents.length = 0;
  return counts;
}

function takeDomainConflicts(domain: string): { deadlock: number; p2034: number } {
  const drained = drainConflictCounts();
  // 非本域事件（如尚未接入观测的 coordinator 域）一并清空，避免跨批次误归属。
  return drained.get(domain) ?? { deadlock: 0, p2034: 0 };
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
