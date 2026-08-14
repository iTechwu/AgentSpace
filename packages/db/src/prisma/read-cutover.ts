// Generic read-cutover runner for Phase 2 repository migrations.
//
// The contract is:
// - Flag OFF  → run the legacy fallback and return it (no metrics, no primary).
// - Flag ON   → run the async primary first.
//   - Shadow ON  → also run the legacy fallback and compare; mismatch is emitted.
//     - Shadow fallback throws → emit a mismatch metric and propagate the error
//       (the fallback exists only for comparison, never for recovery).
//   - Shadow OFF → no fallback call, no compare.
//   - Primary throws → run fallback and emit a fallback metric (do not throw).
//     - Fallback also throws → propagate the primary error (it is what the
//       caller would have seen without the migration).
// - Metric emission must never affect the business read result: if the metric
//   callback throws, swallow it and return the read result anyway.

export interface ReadCutoverMetric {
  source: "primary" | "fallback";
  mismatch: 0 | 1;
  durationMs: number;
  error?: string;
}

export interface ReadCutoverConfig<TResult> {
  isEnabled: () => boolean;
  isShadowEnabled: () => boolean;
  runPrimary: () => Promise<TResult>;
  runFallback: () => TResult;
  compare: (primary: TResult, fallback: TResult) => boolean;
  emitMetric: (metric: ReadCutoverMetric) => void;
}

/**
 * Execute a read with the Phase 2 cutover contract.
 *
 * @see module-level comment for the exact semantics.
 */
export async function withReadCutover<TResult>(config: ReadCutoverConfig<TResult>): Promise<TResult> {
  if (!config.isEnabled()) {
    return config.runFallback();
  }

  const start = Date.now();
  let primaryResult: TResult;

  try {
    primaryResult = await config.runPrimary();
  } catch (primaryError) {
    return runFallbackAfterPrimaryFailure(config, start, primaryError);
  }

  let mismatch: 0 | 1 = 0;
  if (config.isShadowEnabled()) {
    try {
      const fallbackResult = config.runFallback();
      mismatch = config.compare(primaryResult, fallbackResult) ? 0 : 1;
    } catch (shadowError) {
      // Shadow fallback failure: emit mismatch so operators see the drift,
      // then propagate — the fallback is for comparison, not recovery.
      safeEmitMetric(config, {
        source: "primary",
        mismatch: 1,
        durationMs: Date.now() - start,
        error: errorMessage(shadowError),
      });
      throw shadowError;
    }
  }

  safeEmitMetric(config, {
    source: "primary",
    mismatch,
    durationMs: Date.now() - start,
  });
  return primaryResult;
}

function runFallbackAfterPrimaryFailure<TResult>(
  config: ReadCutoverConfig<TResult>,
  start: number,
  primaryError: unknown,
): TResult {
  const primaryMessage = errorMessage(primaryError);
  try {
    const fallbackResult = config.runFallback();
    safeEmitMetric(config, {
      source: "fallback",
      mismatch: 0,
      durationMs: Date.now() - start,
      error: primaryMessage,
    });
    return fallbackResult;
  } catch (fallbackError) {
    // Fallback is broken too; preserve the primary error because it is what
    // the caller would have seen without the migration.
    throw primaryError;
  }
}

function safeEmitMetric<TResult>(
  config: ReadCutoverConfig<TResult>,
  metric: ReadCutoverMetric,
): void {
  try {
    config.emitMetric(metric);
  } catch {
    // Metric emission failure must never affect the business read result.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}