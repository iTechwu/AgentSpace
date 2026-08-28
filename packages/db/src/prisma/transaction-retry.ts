import { AsyncLocalStorage } from "node:async_hooks";

export interface PrismaTransactionRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** SLO 归属标签（如 "workflow-dispatcher"），冲突重试事件按此上报。 */
  scope?: string;
}

/** 冲突类型：40P01/deadlock 归 deadlock，P2034/40001/serialization 归 serialization。 */
export type PrismaTransactionConflictKind = "deadlock" | "serialization";

export interface PrismaTransactionRetryEvent {
  scope: string;
  /** 即将进行的第几次重试（从 1 开始）。 */
  attempt: number;
  kind: PrismaTransactionConflictKind;
  /** true 表示重试耗尽、错误即将原样抛出——该冲突只出现在最终错误里，仍须计入冲突率。 */
  exhausted?: boolean;
}

type PrismaTransactionRetryObserver = (event: PrismaTransactionRetryEvent) => void;

let retryObserver: PrismaTransactionRetryObserver | undefined;

// 按异步调用上下文捕获冲突事件：并发批次各自持有独立缓冲，事件精确归属
// 触发它的那次调用，不会跨批次误归属，也不需要丢弃其他域的残留事件。
const conflictEventCapture = new AsyncLocalStorage<PrismaTransactionRetryEvent[] | undefined>();

/**
 * 在 operation 的异步上下文内捕获事务冲突事件（含成功重试与耗尽终态）。
 * 观测包装层（如 observeWorkflowPrismaWrite）传入自己的缓冲数组并在
 * operation 结束后读取；嵌套调用会建立自己的捕获上下文，互不串扰。
 */
export function runWithPrismaTransactionRetryCapture<T>(
  events: PrismaTransactionRetryEvent[],
  operation: () => Promise<T>,
): Promise<T> {
  return conflictEventCapture.run(events, operation);
}

/**
 * 注册进程级冲突观察者。成功重试的事务冲突不会以外在错误暴露，
 * ADR（0816/06 第 4 节）要求重试计数进入 SLO deadlockRate/p2034Rate，
 * 观察者是上报通道之一（按调用上下文捕获是主通道）。观察者抛错不得影响重试本身。
 */
export function setPrismaTransactionRetryObserver(
  observer: PrismaTransactionRetryObserver | undefined,
): void {
  retryObserver = observer;
}

/** Retry a complete transaction after PostgreSQL serialization or deadlock rollback. */
export async function retryPrismaTransaction<T>(
  operation: () => Promise<T>,
  options: PrismaTransactionRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.min(Math.max(Math.trunc(options.maxAttempts ?? 3), 1), 10);
  const baseDelayMs = Math.min(Math.max(Math.trunc(options.baseDelayMs ?? 10), 0), 1_000);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isPrismaTransactionConflict(error)) throw error;
      const exhausted = attempt === maxAttempts - 1;
      // 耗尽前：记录一次即将进行的重试；耗尽时：错误即将抛出，冲突若不上报
      // 就只剩 errorRate，deadlockRate/p2034Rate 会被低估（ADR 要求完整计入）。
      notifyRetryObserver(options.scope, attempt + 1, error, exhausted);
      if (exhausted) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw new Error("prisma_transaction_retry_exhausted");
}

export function isPrismaTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "P2034" || code === "40001" || code === "40P01"
    || /could not serialize|deadlock detected|serialization failure/i.test(message);
}

export function classifyPrismaTransactionConflictKind(error: unknown): PrismaTransactionConflictKind {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return code === "40P01" || /deadlock detected/i.test(message) ? "deadlock" : "serialization";
}

function notifyRetryObserver(
  scope: string | undefined,
  attempt: number,
  error: unknown,
  exhausted: boolean,
): void {
  const event: PrismaTransactionRetryEvent = {
    scope: scope ?? "prisma-transaction",
    attempt,
    kind: classifyPrismaTransactionConflictKind(error),
  };
  if (exhausted) event.exhausted = true;
  const capture = conflictEventCapture.getStore();
  if (capture) capture.push(event);
  if (!retryObserver) return;
  try {
    retryObserver(event);
  } catch {
    // 观察者失败不得改变重试行为。
  }
}
