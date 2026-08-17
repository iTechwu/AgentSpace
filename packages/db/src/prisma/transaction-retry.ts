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
}

type PrismaTransactionRetryObserver = (event: PrismaTransactionRetryEvent) => void;

let retryObserver: PrismaTransactionRetryObserver | undefined;

/**
 * 注册进程级冲突观察者。成功重试的事务冲突不会以外在错误暴露，
 * ADR（0816/06 第 4 节）要求重试计数进入 SLO deadlockRate/p2034Rate，
 * 观察者是唯一上报通道。观察者抛错不得影响重试本身。
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
      if (!isPrismaTransactionConflict(error) || attempt === maxAttempts - 1) throw error;
      notifyRetryObserver(options.scope, attempt + 1, error);
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

function notifyRetryObserver(scope: string | undefined, attempt: number, error: unknown): void {
  if (!retryObserver) return;
  try {
    retryObserver({
      scope: scope ?? "prisma-transaction",
      attempt,
      kind: classifyPrismaTransactionConflictKind(error),
    });
  } catch {
    // 观察者失败不得改变重试行为。
  }
}
