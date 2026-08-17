export interface PrismaTransactionRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
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
