import {
  completeTokenUsageRetrySync,
  claimDueTokenUsageRetriesSync,
  failTokenUsageRetrySync,
  recordTokenUsageSync,
} from "@dofe-agent/db";

export interface DrainTokenUsageRetriesResult {
  processedCount: number;
  completedCount: number;
  failedCount: number;
}

export function drainTokenUsageRetriesSync(limit = 100): DrainTokenUsageRetriesResult {
  const result: DrainTokenUsageRetriesResult = {
    processedCount: 0,
    completedCount: 0,
    failedCount: 0,
  };
  for (const retry of claimDueTokenUsageRetriesSync(limit)) {
    result.processedCount += 1;
    try {
      recordTokenUsageSync(retry.payload);
      completeTokenUsageRetrySync(retry.id);
      result.completedCount += 1;
    } catch (error) {
      failTokenUsageRetrySync(retry.id, retry.attempts, error);
      result.failedCount += 1;
    }
  }
  return result;
}
