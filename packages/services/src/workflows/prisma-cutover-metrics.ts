import { emitPrismaCutoverMetric } from "@dofe-agent/db";

/** Record a Prisma workflow write without claiming that a shadow comparison ran. */
export async function observeWorkflowPrismaWrite<T>(
  context: { domain: "workflow-dispatcher" | "workflow-materialization"; operation: string },
  operation: () => Promise<T>,
  options: {
    emitMetric?: typeof emitPrismaCutoverMetric;
    now?: () => number;
  } = {},
): Promise<T> {
  const emitMetric = options.emitMetric ?? emitPrismaCutoverMetric;
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const result = await operation();
    emitMetric(context, {
      source: "primary",
      mismatch: 0,
      shadowCompared: 0,
      durationMs: now() - startedAt,
      fallbackInvoked: 0,
    });
    return result;
  } catch (error) {
    emitMetric(context, {
      source: "primary",
      mismatch: 0,
      shadowCompared: 0,
      durationMs: now() - startedAt,
      fallbackInvoked: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
